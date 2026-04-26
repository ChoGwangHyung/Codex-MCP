"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const { MAX_OUTPUT_BYTES } = require("./constants.js");

function spawnCommand(command, args, options) {
  if (os.platform() !== "win32" || command.includes("\\") || command.includes("/") || command.endsWith(".exe")) {
    return spawn(command, args, options);
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
    throw new Error(`Unsupported Windows command name: ${command}`);
  }
  const commandLine = [command, ...args.map(quoteCmdArg)].join(" ");
  return spawn(comspec, ["/d", "/c", commandLine], options);
}

function quoteCmdArg(value) {
  const raw = String(value);
  if (!raw) return "\"\"";
  return `"${raw.replace(/%/g, "%%").replace(/"/g, "\\\"").replace(/([&|<>^])/g, "^$1")}"`;
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    const child = spawnCommand(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      if (!finished) child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr, error: error.message, timedOut: false });
    });
    child.on("close", (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0 && signal !== "SIGTERM", exitCode, stdout, stderr, error: null, timedOut: signal === "SIGTERM" });
    });
    child.stdin.end(options.input || "");
  });
}

function appendCapped(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-MAX_OUTPUT_BYTES).toString("utf8");
}

module.exports = {
  runCommand
};
