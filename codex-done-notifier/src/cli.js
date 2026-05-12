#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOOK_BEGIN = "# BEGIN codex-done-notifier hook";
const HOOK_END = "# END codex-done-notifier hook";
const MARKER_FILE = "notify-on-stop";

async function main(argv = process.argv) {
  const command = String(argv[2] || "help").toLowerCase();
  try {
    if (command === "configure") return configure(argv.slice(3));
    if (command === "unconfigure") return unconfigure(argv.slice(3));
    if (command === "enable") return enable(argv.slice(3));
    if (command === "disable") return disable();
    if (command === "status") return status(argv.slice(3));
    if (command === "hook") return hook();
    if (command === "test") return testNotification();
    if (command === "hook-snippet") return printHookSnippet();
    usage(command === "help" ? 0 : 1);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

function configure(args = []) {
  const result = ensureHookInstalled({ global: hasFlag(args, "--global"), cwd: process.cwd() });
  console.log(`${result.changed ? "installed" : "already installed"}: ${result.path}`);
  if (!hasFlag(args, "--no-enable")) enable(args);
}

function unconfigure(args = []) {
  const file = codexConfigPath({ global: hasFlag(args, "--global"), cwd: process.cwd() });
  const before = readText(file);
  const after = removeManagedHookBlock(before);
  if (after !== before) fs.writeFileSync(file, after ? `${after.trimEnd()}\n` : "");
  console.log(`removed: ${file}`);
}

function enable(args = []) {
  const cwd = process.cwd();
  const marker = markerPath(cwd);
  const sessionId = optionValue(args, "--session");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    enabled: true,
    sessions: sessionId ? [sessionId] : [],
    createdAt: new Date().toISOString()
  }, null, 2));
  console.log(`enabled: ${marker}`);
  if (sessionId) console.log(`session: ${sessionId}`);
}

function disable() {
  const marker = markerPath(process.cwd());
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  console.log(`disabled: ${marker}`);
}

function status(args = []) {
  const cwd = process.cwd();
  const marker = findMarker(cwd);
  const localHookStatus = doneHookStatus({ global: false, cwd });
  const globalHookStatus = doneHookStatus({ global: true, cwd });
  const selectedHookStatus = hasFlag(args, "--global") ? globalHookStatus : localHookStatus;
  console.log(`hook_installed: ${selectedHookStatus.installed ? "yes" : "no"}`);
  console.log(`hook_config: ${selectedHookStatus.path}`);
  console.log(`local_hook_installed: ${localHookStatus.installed ? "yes" : "no"}`);
  console.log(`local_hook_config: ${localHookStatus.path}`);
  console.log(`global_hook_installed: ${globalHookStatus.installed ? "yes" : "no"}`);
  console.log(`global_hook_config: ${globalHookStatus.path}`);
  console.log(`cwd: ${cwd}`);
  console.log(`enabled_here: ${marker ? "yes" : "no"}`);
  if (marker) console.log(`marker: ${marker}`);
  console.log(`session_env_enabled: ${process.env.CODEX_DONE_NOTIFIER_ENABLED === "1" ? "yes" : "no"}`);
}

async function hook() {
  const input = parseJson(await readStdin());
  await handleHookInput(input);
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
}

async function testNotification() {
  await sendNotification({
    title: process.env.CODEX_DONE_NOTIFIER_TITLE || "Codex task completed",
    body: "codex-done-notifier test notification"
  });
  console.log("sent");
}

function printHookSnippet() {
  process.stdout.write(`${ensureCodexHooksFeature("")}${appendManagedHookBlock("", hookCommand()).trimEnd()}\n`);
}

async function handleHookInput(input) {
  const cwd = String(input && input.cwd || process.cwd());
  const sessionId = String(input && (input.session_id || input.sessionId) || "");
  const marker = findMarker(cwd);
  if (!shouldNotify({ marker, sessionId })) {
    return { notified: false, reason: "not enabled" };
  }

  await sendNotification({
    title: process.env.CODEX_DONE_NOTIFIER_TITLE || "Codex task completed",
    body: notificationBody(input, cwd)
  });
  return { notified: true, marker };
}

function shouldNotify({ marker, sessionId }) {
  if (process.env.CODEX_DONE_NOTIFIER_ENABLED === "1") return true;
  if (sessionId && sessionList(process.env.CODEX_DONE_NOTIFIER_SESSION_IDS).includes(sessionId)) return true;
  if (!marker) return false;
  const config = readMarkerConfig(marker);
  if (config.enabled === false) return false;
  if (Array.isArray(config.sessions) && config.sessions.length > 0) {
    return sessionId ? config.sessions.map(String).includes(sessionId) : false;
  }
  return true;
}

function notificationBody(input, cwd) {
  const name = path.basename(path.resolve(cwd)) || path.resolve(cwd);
  const message = String(input && (input.last_assistant_message || input.lastAssistantMessage) || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!message) return `${name} is done.`;
  return `${name}: ${truncate(message, 160)}`;
}

async function sendNotification({ title, body }) {
  if (process.env.CODEX_DONE_NOTIFIER_DRY_RUN === "1") return;
  const safeTitle = truncate(String(title || "Codex task completed"), 80);
  const safeBody = truncate(String(body || "Done."), 220);
  if (process.platform === "win32") {
    spawnDetached("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(windowsNotificationScript(safeTitle, safeBody), "utf16le").toString("base64")
    ]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("osascript", [
      "-e",
      `display notification ${appleScriptString(safeBody)} with title ${appleScriptString(safeTitle)} sound name "Glass"`
    ]);
    return;
  }
  spawnDetached("sh", [
    "-c",
    "if command -v notify-send >/dev/null 2>&1; then notify-send \"$1\" \"$2\"; fi",
    "codex-done-notifier",
    safeTitle,
    safeBody
  ]);
}

function windowsNotificationScript(title, body) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Media.SystemSounds]::Asterisk.Play()",
    "$notify = New-Object System.Windows.Forms.NotifyIcon",
    "$notify.Icon = [System.Drawing.SystemIcons]::Information",
    `$notify.BalloonTipTitle = ${powerShellString(title)}`,
    `$notify.BalloonTipText = ${powerShellString(body)}`,
    "$notify.Visible = $true",
    "$notify.ShowBalloonTip(5000)",
    "Start-Sleep -Seconds 6",
    "$notify.Dispose()"
  ].join("\n");
}

function ensureHookInstalled(options = {}) {
  const file = codexConfigPath(options);
  const before = readText(file);
  const withoutBlock = removeManagedHookBlock(before);
  const withFeature = ensureCodexHooksFeature(withoutBlock);
  const after = appendManagedHookBlock(withFeature, hookCommand());
  if (after !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
    return { installed: true, changed: true, path: file };
  }
  return { installed: true, changed: false, path: file };
}

function doneHookStatus(options = {}) {
  const file = codexConfigPath(options);
  const text = readText(file);
  return { installed: text.includes(HOOK_BEGIN) && text.includes(HOOK_END), path: file };
}

function codexConfigPath(options = {}) {
  if (process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE) return process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE;
  if (options.global) return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  return path.join(path.resolve(options.cwd || process.cwd()), ".codex", "config.toml");
}

function hookCommand() {
  if (process.env.CODEX_DONE_NOTIFIER_HOOK_COMMAND) return process.env.CODEX_DONE_NOTIFIER_HOOK_COMMAND;
  return `node ${quoteCommandArg(__filename)} hook`;
}

function removeManagedHookBlock(text) {
  const pattern = new RegExp(`\\r?\\n?${escapeRegex(HOOK_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_END)}\\r?\\n?`, "g");
  return String(text || "")
    .replace(pattern, (block) => {
      const preserved = extractHookStateSection(block);
      return preserved ? `\n${preserved}\n` : "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function extractHookStateSection(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preserved = [];
  let preserving = false;
  for (const line of lines) {
    if (line === HOOK_BEGIN || line === HOOK_END) continue;
    if (/^\s*\[hooks\.state(?:\]|\.)/.test(line)) preserving = true;
    else if (preserving && /^\s*\[/.test(line) && !/^\s*\[hooks\.state(?:\]|\.)/.test(line)) preserving = false;
    if (preserving) preserved.push(line);
  }
  return preserved.join("\n").trim();
}

function ensureCodexHooksFeature(text) {
  const content = String(text || "");
  const lines = content.split(/\r?\n/);
  const featureHeaderIndex = lines.findIndex((line) => /^\s*\[features]\s*$/.test(line));
  if (featureHeaderIndex < 0) return appendSection(content, ["[features]", "hooks = true"].join("\n"));

  let nextTableIndex = lines.length;
  for (let index = featureHeaderIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      nextTableIndex = index;
      break;
    }
  }

  let hasHooksFeature = false;
  for (let index = nextTableIndex - 1; index > featureHeaderIndex; index -= 1) {
    if (/^\s*codex_hooks\s*=/.test(lines[index])) {
      lines.splice(index, 1);
      nextTableIndex -= 1;
      continue;
    }
    if (/^\s*hooks\s*=/.test(lines[index])) {
      lines[index] = "hooks = true";
      hasHooksFeature = true;
    }
  }

  if (!hasHooksFeature) lines.splice(featureHeaderIndex + 1, 0, "hooks = true");
  return lines.join("\n").trimEnd();
}

function appendManagedHookBlock(text, command) {
  return appendSection(text, [
    HOOK_BEGIN,
    "[[hooks.Stop]]",
    'matcher = "*"',
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 5",
    'statusMessage = "Sending completion notification"',
    HOOK_END
  ].join("\n"));
}

function appendSection(text, section) {
  const content = String(text || "").trimEnd();
  if (!content) return `${section}\n`;
  return `${content}\n\n${section}\n`;
}

function markerPath(cwd) {
  return path.join(cwd, ".codex", MARKER_FILE);
}

function findMarker(cwd) {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    const marker = markerPath(current);
    if (fs.existsSync(marker)) return marker;
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function readMarkerConfig(marker) {
  const raw = readText(marker).trim();
  if (!raw) return { enabled: true };
  const parsed = parseJson(raw);
  return parsed && typeof parsed === "object" ? parsed : { enabled: true };
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function parseJson(raw) {
  try {
    return String(raw || "").trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return String(args[index + 1] || "").trim();
}

function hasFlag(args, name) {
  return args.includes(name);
}

function sessionList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Notification failures must not affect the Codex turn.
  }
}

function quoteCommandArg(value) {
  const text = String(value || "");
  return /[\s&()[\]{}^=;!'+,`~]/.test(text)
    ? `"${text.replace(/"/g, '\\"')}"`
    : text;
}

function powerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function appleScriptString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usage(exitCode) {
  console.log([
    "Usage: codex-done-notifier <command>",
    "",
    "Commands:",
    "  configure       Install the local project Codex Stop hook and enable notifications",
    "  configure --global",
    "                  Install the user-level Codex Stop hook and enable this project",
    "  configure --no-enable",
    "                  Install the hook without creating the project marker",
    "  unconfigure     Remove the local managed Stop hook block",
    "  unconfigure --global",
    "                  Remove the user-level managed Stop hook block",
    "  enable          Enable notifications for the current project",
    "  enable --session <id>",
    "                  Enable notifications only for one Codex session id",
    "  disable         Disable notifications for the current project",
    "  status          Show hook and current project status",
    "  hook            Run as a Codex Stop hook",
    "  test            Send a test notification",
    "  hook-snippet    Print the managed hook TOML"
  ].join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main();
}

module.exports = {
  _test: {
    appendManagedHookBlock,
    doneHookStatus,
    ensureCodexHooksFeature,
    ensureHookInstalled,
    findMarker,
    handleHookInput,
    markerPath,
    notificationBody,
    readMarkerConfig,
    removeManagedHookBlock,
    codexConfigPath,
    extractHookStateSection,
    shouldNotify
  }
};
