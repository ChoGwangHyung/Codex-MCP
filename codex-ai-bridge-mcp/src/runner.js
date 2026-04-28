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
    const startedAtMs = Date.now();
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    const child = spawnCommand(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (typeof options.onStart === "function") options.onStart({ pid: child.pid });
    const timer = providerTimeoutMs(options.timeoutMs) > 0
      ? setTimeout(() => {
        if (!finished) {
          timedOut = true;
          terminateChild(child);
        }
      }, providerTimeoutMs(options.timeoutMs))
      : null;
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      resolve(commandResult({ ok: false, exitCode: null, stdout, stderr, error: error.message, timedOut, child, startedAtMs }));
    });
    child.on("close", (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      resolve(commandResult({ ok: exitCode === 0 && !timedOut && signal !== "SIGTERM", exitCode, stdout, stderr, error: null, timedOut: timedOut || signal === "SIGTERM", child, startedAtMs }));
    });
    child.stdin.end(options.input || "");
  });
}

function commandResult(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timedOut: result.timedOut,
    pid: result.child && result.child.pid ? result.child.pid : null,
    elapsedMs: Date.now() - result.startedAtMs
  };
}

function providerTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

function terminateChild(child) {
  if (!child || !child.pid) return;
  if (os.platform() === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore"
    });
    const fallback = setTimeout(() => {
      child.kill("SIGTERM");
    }, 1000);
    if (typeof fallback.unref === "function") fallback.unref();
    killer.on("error", () => {
      clearTimeout(fallback);
      killChild(child);
    });
    killer.on("close", (exitCode) => {
      if (exitCode === 0) clearTimeout(fallback);
    });
    return;
  }
  killChild(child);
}

function killChild(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already be gone.
  }
}

function appendCapped(current, chunk) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-MAX_OUTPUT_BYTES).toString("utf8");
}

module.exports = {
  runCommand,
  terminateChild,
  providerTimeoutMs
};
