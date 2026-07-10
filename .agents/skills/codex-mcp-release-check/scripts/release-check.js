#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../../..");
const packages = [
  {
    dir: "codex-ai-bridge-mcp",
    entry: "src/index.js",
    tools: ["claude_task", "gemini_task", "antigravity_task", "cross_review", "ai_bridge_job", "ai_bridge_health"]
  },
  {
    dir: "codex-telegram-bridge-mcp",
    entry: "src/index.js",
    tools: ["telegram_send", "telegram_send_file", "telegram_send_photo", "telegram_send_document", "telegram_ask", "telegram_approval_request"]
  },
  { dir: "codex-done-notifier" }
];

async function main() {
  run("git", ["diff", "--check"], root);
  runNpm(["run", "check"], root);

  for (const pkg of packages) {
    checkPackageContents(pkg);
    if (pkg.entry) await smokeMcp(pkg);
  }

  scanRepository();
  process.stdout.write("Release checks passed.\n");
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    shell: false,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
}

function checkPackageContents(pkg) {
  const cwd = path.join(root, pkg.dir);
  const output = runNpm(["pack", "--dry-run", "--json"], cwd);
  const parsed = JSON.parse(output);
  const files = parsed[0] && Array.isArray(parsed[0].files) ? parsed[0].files.map((item) => item.path) : [];
  const forbidden = files.filter((file) => /(^|\/)(test|\.codex|node_modules)(\/|$)|(^|\/)\.env(?:\.|$)/i.test(file));
  if (forbidden.length) throw new Error(`${pkg.dir} would publish forbidden files: ${forbidden.join(", ")}`);
  for (const required of ["package.json", "LICENSE", "README.md", "README.ko.md"]) {
    if (!files.includes(required)) throw new Error(`${pkg.dir} tarball is missing ${required}`);
  }
}

function smokeMcp(pkg) {
  return new Promise((resolve, reject) => {
    const cwd = path.join(root, pkg.dir);
    const child = spawn(process.execPath, [pkg.entry], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_TELEGRAM_ENABLED: "0",
        CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL: "0"
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${pkg.dir} JSON-RPC smoke timed out`)), 10000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2 || !message.result) continue;
        const names = (message.result.tools || []).map((tool) => tool.name);
        const missing = pkg.tools.filter((name) => !names.includes(name));
        if (missing.length) return finish(new Error(`${pkg.dir} tools/list is missing: ${missing.join(", ")}`));
        finish();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", finish);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) finish(new Error(`${pkg.dir} exited with ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-check", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
    }
  });
}

function scanRepository() {
  const tokenPatterns = [
    /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
  ];
  const localPathPatterns = [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, /\/Users\/[^/\s"']+/g, /\/home\/[^/\s"']+/g];
  const projectNames = ["AllIn" + "Board", "TaskPilot" + "Signal", "Talk" + "Log"];
  const findings = [];
  walk(root, (file) => {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    if (relative === ".agents/skills/codex-mcp-release-check/scripts/release-check.js") return;
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const pattern of [...tokenPatterns, ...localPathPatterns]) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) findings.push(relative);
    }
    if (projectNames.some((name) => content.includes(name))) findings.push(relative);
  });
  if (findings.length) throw new Error(`sensitive or machine-specific content found in: ${[...new Set(findings)].join(", ")}`);
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function runNpm(args, cwd) {
  const npmExecPath = String(process.env.npm_execpath || "");
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], cwd);
  }
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", ["npm", ...args].map(quoteCmdArg).join(" ")], cwd);
  }
  return run("npm", args, cwd);
}

function quoteCmdArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

main().catch((error) => {
  process.stderr.write(`Release check failed: ${error.message}\n`);
  process.exitCode = 1;
});
