"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MAX_OUTPUT_BYTES } = require("./constants.js");

const activeChildren = new Set();
const terminatingChildren = new WeakSet();
const windowsCommandCache = new Map();
const FORCE_KILL_DELAY_MS = 1000;
let windowsShimSequence = 0;

function spawnCommand(command, args, options) {
  if (os.platform() !== "win32") {
    return spawn(command, args, { ...options, detached: true });
  }
  const resolved = resolveWindowsCommand(command);
  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".ps1") {
    return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args], options);
  }
  if (extension !== ".cmd" && extension !== ".bat") {
    return spawn(resolved, args, options);
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  const shim = windowsCommandShim(resolved, args, options.env);
  return spawn(comspec, ["/d", "/s", "/c", `"${shim.commandLine}"`], {
    ...options,
    env: shim.env,
    windowsVerbatimArguments: true
  });
}

// A full PATH x PATHEXT stat sweep per spawn is measurable on Windows, and the
// answer only changes when PATH itself does, so it is cached against both.
function resolveWindowsCommand(command) {
  const value = String(command || "");
  if (!value) throw new Error("command is required");
  if (value.includes("\\") || value.includes("/") || path.isAbsolute(value)) return value;
  const cacheKey = `${value}\0${process.env.PATH || ""}\0${process.env.PATHEXT || ""}`;
  const cached = windowsCommandCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = searchWindowsCommand(value);
  if (windowsCommandCache.size > 64) windowsCommandCache.clear();
  windowsCommandCache.set(cacheKey, resolved);
  return resolved;
}

function searchWindowsCommand(value) {
  const extensions = path.extname(value)
    ? [""]
    : String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean);
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, "");
    if (!cleanDirectory) continue;
    for (const extension of extensions) {
      const candidate = path.join(cleanDirectory, `${value}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return value;
}

function windowsCommandShim(command, args, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  const prefix = `CODEX_AI_BRIDGE_SHIM_${process.pid}_${windowsShimSequence++}`;
  const references = [command, ...args].map((value, index) => {
    const raw = String(value);
    if (/[\0\r\n"]/.test(raw)) {
      throw new Error("Windows command shim arguments cannot contain quotes or newlines");
    }
    const key = `${prefix}_${index}`;
    env[key] = raw;
    return `"%${key}%"`;
  });
  return {
    env,
    commandLine: references.join(" ")
  };
}

function killProcessGroup(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const stdout = createCappedBuffer();
    const stderr = createCappedBuffer();
    let finished = false;
    let timedOut = false;
    let child;
    try {
      child = spawnCommand(command, args, {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      resolve(commandResult({
        ok: false,
        exitCode: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        error: error.message,
        timedOut,
        child: null,
        startedAtMs
      }));
      return;
    }
    activeChildren.add(child);
    if (typeof options.onStart === "function") options.onStart({ pid: child.pid });
    const timer = providerTimeoutMs(options.timeoutMs) > 0
      ? setTimeout(() => {
        if (!finished) {
          timedOut = true;
          terminateChild(child);
        }
      }, providerTimeoutMs(options.timeoutMs))
      : null;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      activeChildren.delete(child);
      clearTimer(timer);
      resolve(commandResult({ ok: false, exitCode: null, stdout: stdout.text(), stderr: stderr.text(), error: error.message, timedOut, child, startedAtMs }));
    });
    child.on("close", (exitCode, signal) => {
      if (finished) return;
      finished = true;
      activeChildren.delete(child);
      clearTimer(timer);
      resolve(commandResult({ ok: exitCode === 0 && !timedOut && signal !== "SIGTERM", exitCode, stdout: stdout.text(), stderr: stderr.text(), error: null, timedOut: timedOut || signal === "SIGTERM", child, startedAtMs }));
    });
    child.stdin.on("error", () => {});
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
  if (terminatingChildren.has(child)) return;
  terminatingChildren.add(child);
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
  const processGroup = killProcessGroup(child);
  if (!processGroup) killChild(child);
  scheduleForceKill(child, processGroup);
}

function scheduleForceKill(child, processGroup) {
  const timer = setTimeout(() => {
    if (!activeChildren.has(child)) return;
    if (processGroup && killProcessGroup(child, "SIGKILL")) return;
    killChild(child, "SIGKILL");
  }, FORCE_KILL_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
  const clear = () => clearTimeout(timer);
  child.once("close", clear);
  child.once("error", clear);
}

async function terminateAllChildren(waitMs = 1500) {
  const children = [...activeChildren];
  for (const child of children) terminateChild(child);
  if (children.length === 0) return;
  await Promise.race([
    Promise.all(children.map((child) => new Promise((resolve) => {
      if (!activeChildren.has(child)) return resolve();
      child.once("close", resolve);
      child.once("error", resolve);
    }))),
    new Promise((resolve) => setTimeout(resolve, waitMs))
  ]);
}

function killChild(child, signal = "SIGTERM") {
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

// Keeps the trailing MAX_OUTPUT_BYTES without re-encoding everything received
// so far on every chunk. The previous string-concat form re-measured the whole
// accumulated output per event, which is quadratic on a chatty provider.
function createCappedBuffer() {
  const chunks = [];
  let totalBytes = 0;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      chunks.push(buffer);
      totalBytes += buffer.length;
      while (totalBytes > MAX_OUTPUT_BYTES && chunks.length > 0) {
        const excess = totalBytes - MAX_OUTPUT_BYTES;
        if (chunks[0].length <= excess) {
          totalBytes -= chunks[0].length;
          chunks.shift();
          continue;
        }
        totalBytes -= excess;
        chunks[0] = chunks[0].subarray(excess);
      }
    },
    text() {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    }
  };
}

module.exports = {
  runCommand,
  terminateChild,
  terminateAllChildren,
  providerTimeoutMs
};
