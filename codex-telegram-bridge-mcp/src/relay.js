"use strict";

const net = require("node:net");
const path = require("node:path");
const {
  SERVER_VERSION,
  DEFAULT_APP_SERVER_TIMEOUT_MS,
  APP_SERVER_ENDPOINT_CACHE_MS
} = require("./constants.js");
const {
  allowedChatIds,
  relayConsolePid,
  relayConsoleSubmitDelayMs,
  relayEnabled,
  relayIgnoreExisting,
  relayMode,
  relayReplyRequired,
  relayTargetCwd,
  relayTargetThreadId,
  telegramEnabled
} = require("./config.js");
const {
  readTelegramState,
  writeTelegramState,
  withTelegramStateLock
} = require("./state.js");
const {
  execFileText,
  normalizePath,
  parseBrokerCommandLine,
  parseJsonRows,
  sanitize,
  singleLine
} = require("./util.js");

let relayStarted = false;
let relayRunning = false;
let relayInFlight = null;
let relayLastError = "";
let relayLastErrorAt = "";
let relayLastInjectedAt = "";
let relayLastThreadId = "";
let relayLastConsolePid = "";
let relayEndpointCache = { value: "", resolvedAt: 0 };
const RELAY_INJECTING_STALE_MS = 120000;

function startTelegramRelay() {
  if (relayStarted || !relayEnabled() || !telegramEnabled()) return;
  relayStarted = true;
  initializeRelayState();
  scheduleRelayPendingMessages();
}

function initializeRelayState() {
  const state = readTelegramState();
  const now = new Date().toISOString();
  state.relay = state.relay && typeof state.relay === "object" ? state.relay : {};
  if (!state.relay.startedAt) {
    state.relay.startedAt = now;
    if (relayIgnoreExisting()) {
      for (const message of state.inbox) {
        if (!message.relayStatus) {
          message.relayStatus = "skipped_existing";
          message.relaySkippedAt = now;
        }
      }
    }
  }
  writeTelegramState(state);
}

function scheduleRelayPendingMessages() {
  if (!relayStarted || !relayEnabled()) return;
  if (relayInFlight) return;
  relayInFlight = relayPendingMessages()
    .catch((error) => {
      relayLastError = sanitize(error.message || "relay error");
      relayLastErrorAt = new Date().toISOString();
      updateRelayState({ lastError: relayLastError, lastErrorAt: relayLastErrorAt });
    })
    .finally(() => {
      relayInFlight = null;
    });
}

async function relayPendingMessages() {
  relayRunning = true;
  try {
    while (true) {
      const claim = await claimRelayMessage();
      if (!claim) break;
      const keepGoing = await processRelayClaim(claim);
      if (!keepGoing) break;
    }
  } finally {
    relayRunning = false;
  }
}

async function claimRelayMessage() {
  return withTelegramStateLock(async () => {
    const state = readTelegramState();
    const allowed = allowedChatIds();
    let changed = false;

    for (const message of state.inbox) {
      if (!allowed.has(message.chatId)) continue;
      if (!isRelayCandidate(message, state)) {
        if (shouldSkipRelayMessage(message, state)) {
          markRelaySkipped(message, skipRelayReason(message, state));
          changed = true;
        }
        continue;
      }

      message.relayStatus = "injecting";
      message.relayLastAttemptAt = new Date().toISOString();
      message.relayAttempts = Number(message.relayAttempts || 0) + 1;
      writeTelegramState(state);
      return {
        mode: relayMode(),
        message: { ...message }
      };
    }

    if (changed) writeTelegramState(state);
    return null;
  });
}

async function processRelayClaim(claim) {
  const { mode, message } = claim;
  try {
    let result;
    if (mode === "app-server") {
      const target = await findRelayTargetThread();
      const status = target.thread.status && target.thread.status.type || "unknown";
      if (status !== "idle") {
        relayLastError = `target thread is ${status}`;
        relayLastErrorAt = new Date().toISOString();
        await updateClaimedRelayMessage(message.id, (state, current) => {
          state.relay.lastError = relayLastError;
          state.relay.lastErrorAt = relayLastErrorAt;
          current.relayStatus = "pending";
        });
        return false;
      }
      result = await injectMessageIntoCodexAppServer(target.endpoint, target.thread.id, message);
      relayLastThreadId = target.thread.id;
    } else {
      const status = await relayConsoleThreadStatus();
      if (status && status !== "idle") {
        relayLastError = `target thread is ${status}`;
        relayLastErrorAt = new Date().toISOString();
        await updateClaimedRelayMessage(message.id, (state, current) => {
          state.relay.lastError = relayLastError;
          state.relay.lastErrorAt = relayLastErrorAt;
          current.relayStatus = "pending";
        });
        return false;
      }
      const target = await findCodexConsoleTarget();
      result = await injectMessageIntoCodexConsole(target, message);
      relayLastConsolePid = String(target.processId || "");
      relayLastThreadId = target.threadId || relayTargetThreadId() || "";
    }

    relayLastInjectedAt = new Date().toISOString();
    relayLastError = "";
    relayLastErrorAt = "";
    await updateClaimedRelayMessage(message.id, (state, current) => {
      current.relayStatus = "delivered";
      current.relayDeliveredAt = relayLastInjectedAt;
      current.relayMode = mode;
      current.relayResult = result;
      current.relayThreadId = relayLastThreadId;
      if (mode === "app-server") {
        current.relayTurnId = result && result.turn && result.turn.id || "";
      } else {
        current.relayConsolePid = relayLastConsolePid;
        current.relayTurnId = "";
      }
      state.relay.lastThreadId = relayLastThreadId;
      state.relay.lastConsolePid = relayLastConsolePid;
      state.relay.lastInjectedAt = relayLastInjectedAt;
      state.relay.lastError = "";
      state.relay.lastErrorAt = "";
    });
    return true;
  } catch (error) {
    relayLastError = sanitize(error.message || "relay error");
    relayLastErrorAt = new Date().toISOString();
    await updateClaimedRelayMessage(message.id, (state, current) => {
      current.relayStatus = "failed";
      current.relayLastError = relayLastError;
      current.relayLastErrorAt = relayLastErrorAt;
      state.relay.lastError = relayLastError;
      state.relay.lastErrorAt = relayLastErrorAt;
    });
    throw error;
  }
}

async function updateClaimedRelayMessage(messageId, update) {
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    state.relay = state.relay && typeof state.relay === "object" ? state.relay : {};
    const current = state.inbox.find((message) => message.id === messageId);
    if (!current) return;
    update(state, current);
    writeTelegramState(state);
  });
}

function isRelayCandidate(message, state) {
  if (!message || message.relayStatus === "delivered" || /^skipped_/.test(String(message.relayStatus || ""))) {
    return false;
  }
  if (message.relayStatus === "injecting" && !isStaleRelayInjection(message)) return false;
  if (shouldSkipRelayMessage(message, state)) return false;
  return ["", "pending", "failed", "injecting"].includes(String(message.relayStatus || ""));
}

function isStaleRelayInjection(message) {
  const lastAttemptAt = Date.parse(message.relayLastAttemptAt || "");
  return !Number.isFinite(lastAttemptAt) || Date.now() - lastAttemptAt > RELAY_INJECTING_STALE_MS;
}

function shouldSkipRelayMessage(message, state) {
  if (/^\/start\b/i.test(String(message.text || "").trim())) return true;
  if (!relayIgnoreExisting()) return false;
  const startedAt = Date.parse(state.relay && state.relay.startedAt || "");
  const messageAt = Date.parse(message.receivedAt || message.date || "");
  return Number.isFinite(startedAt) && Number.isFinite(messageAt) && messageAt < startedAt;
}

function skipRelayReason(message, state) {
  if (/^\/start\b/i.test(String(message.text || "").trim())) return "skipped_command";
  if (relayIgnoreExisting()) {
    const startedAt = Date.parse(state.relay && state.relay.startedAt || "");
    const messageAt = Date.parse(message.receivedAt || message.date || "");
    if (Number.isFinite(startedAt) && Number.isFinite(messageAt) && messageAt < startedAt) {
      return "skipped_existing";
    }
  }
  return "skipped";
}

function markRelaySkipped(message, reason) {
  if (message.relayStatus === reason) return;
  message.relayStatus = reason;
  message.relaySkippedAt = new Date().toISOString();
}

function updateRelayState(fields) {
  const state = readTelegramState();
  state.relay = { ...(state.relay || {}), ...fields };
  writeTelegramState(state);
}

async function telegramRelayStatus() {
  startTelegramRelay();
  const state = readTelegramState();
  const counts = new Map();
  for (const message of state.inbox) {
    const key = message.relayStatus || "pending";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [
    `telegram_relay: ${relayEnabled() ? "enabled" : "disabled"}`,
    `mode: ${relayMode()}`,
    `started: ${relayStarted ? "yes" : "no"}`,
    `running: ${relayRunning || relayInFlight ? "yes" : "no"}`,
    `reply_required: ${relayReplyRequired() ? "yes" : "no"}`,
    `target_cwd: ${relayTargetCwd()}`,
    `target_thread_id: ${relayTargetThreadId() || relayLastThreadId || "auto"}`,
    `target_console_pid: ${relayConsolePid() || relayLastConsolePid || state.relay && state.relay.lastConsolePid || "auto"}`,
    `started_at: ${state.relay && state.relay.startedAt || "never"}`,
    `last_injected_at: ${relayLastInjectedAt || state.relay && state.relay.lastInjectedAt || "never"}`,
    `last_error: ${relayLastError || state.relay && state.relay.lastError || "none"}`,
    ...Array.from(counts.entries()).map(([status, count]) => `${status}: ${count}`)
  ].join("\n");
}

async function findRelayTargetThread() {
  const endpoint = await resolveAppServerEndpoint();
  const explicitThreadId = relayTargetThreadId();
  if (explicitThreadId) {
    const response = await appServerRequest(endpoint, "thread/read", {
      threadId: explicitThreadId,
      includeTurns: false
    });
    return { endpoint, thread: response.thread };
  }

  const loaded = await appServerRequest(endpoint, "thread/loaded/list", { limit: 50 });
  const ids = Array.isArray(loaded.data) ? loaded.data : [];
  const targetCwd = relayTargetCwd();
  const candidates = [];
  for (const threadId of ids) {
    try {
      const response = await appServerRequest(endpoint, "thread/read", {
        threadId,
        includeTurns: false
      });
      const thread = response.thread;
      if (!thread || normalizePath(thread.cwd) !== targetCwd) continue;
      candidates.push(thread);
    } catch {
      // Ignore stale loaded thread ids and keep looking.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`no loaded Codex thread for cwd ${targetCwd}`);
  }

  candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return { endpoint, thread: candidates[0] };
}

async function injectMessageIntoCodexAppServer(endpoint, threadId, message) {
  return appServerRequest(endpoint, "turn/start", {
    threadId,
    input: [{ type: "text", text: formatRelayPrompt(message) }]
  });
}

async function findCodexConsoleTarget() {
  if (process.platform !== "win32") {
    throw new Error("console relay mode is only supported on Windows");
  }

  const scriptPath = path.join(__dirname, "..", "scripts", "codex-console-target.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-StartPid",
    String(process.pid)
  ];
  const threadId = relayTargetThreadId();
  const consolePid = relayConsolePid();
  if (threadId) args.push("-ThreadId", threadId);
  if (consolePid) args.push("-ConsolePid", consolePid);

  const stdout = await execFileText("powershell.exe", args, 10000);
  const rows = parseJsonRows(stdout);
  const target = rows[0];
  if (!target || !target.ProcessId) {
    throw new Error("Codex console process was not found");
  }
  if (target.Name && String(target.Name).toLowerCase() !== "codex.exe") {
    throw new Error(`target process is not codex.exe: ${target.Name}`);
  }
  return {
    processId: Number(target.ProcessId),
    parentProcessId: Number(target.ParentProcessId || 0),
    threadId: String(target.ThreadId || ""),
    source: String(target.Source || ""),
    commandLine: String(target.CommandLine || "")
  };
}

async function relayConsoleThreadStatus() {
  try {
    const target = await findRelayTargetThread();
    return target.thread && target.thread.status && target.thread.status.type || "unknown";
  } catch (error) {
    if (process.env.CODEX_TELEGRAM_CODEX_CONSOLE_REQUIRE_IDLE === "1") {
      throw error;
    }
    return "";
  }
}

async function injectMessageIntoCodexConsole(target, message) {
  if (!target || !target.processId) {
    throw new Error("Codex console target is missing");
  }

  const scriptPath = path.join(__dirname, "..", "scripts", "codex-console-inject.ps1");
  const prompt = formatConsoleRelayPrompt(message);
  const textBase64 = Buffer.from(prompt, "utf8").toString("base64");
  const stdout = await execFileText("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Pid",
    String(target.processId),
    "-TextBase64",
    textBase64,
    "-SubmitDelayMs",
    String(relayConsoleSubmitDelayMs())
  ], 10000);

  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    return { ok: true, stdout: String(stdout || "").trim() };
  }
}

function formatRelayPrompt(message) {
  const text = sanitize(message.text);
  return [
    `[Telegram chatId ${message.chatId}]`,
    text,
    ...relayReplyInstructionLines(message)
  ].filter((line) => line !== "").join("\n");
}

function formatConsoleRelayPrompt(message) {
  const text = singleLine(sanitize(message.text));
  const prompt = `[Telegram chatId ${message.chatId}] ${text}`.trim();
  const instruction = relayReplyInstructionLine(message);
  return instruction ? `${prompt} ${instruction}`.trim() : prompt;
}

function relayReplyInstructionLines(message) {
  const instruction = relayReplyInstructionLine(message);
  return instruction ? ["", instruction] : [];
}

function relayReplyInstructionLine(message) {
  if (!relayReplyRequired()) return "";
  return `Required: after completing this Telegram-origin request, call telegram_send with chatId ${message.chatId} and a concise result.`;
}

async function resolveAppServerEndpoint() {
  const configured = process.env.CODEX_TELEGRAM_CODEX_APP_SERVER_ENDPOINT ||
    process.env.CODEX_APP_SERVER_ENDPOINT;
  if (configured) return configured;

  const now = Date.now();
  if (relayEndpointCache.value && now - relayEndpointCache.resolvedAt < APP_SERVER_ENDPOINT_CACHE_MS) {
    return relayEndpointCache.value;
  }

  const discovered = await discoverAppServerEndpoint();
  relayEndpointCache = { value: discovered, resolvedAt: now };
  return discovered;
}

async function discoverAppServerEndpoint() {
  if (process.platform !== "win32") {
    throw new Error("CODEX_TELEGRAM_CODEX_APP_SERVER_ENDPOINT is required on non-Windows platforms");
  }

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    "Get-CimInstance Win32_Process |",
    "Where-Object { $_.CommandLine -like '*app-server-broker.mjs serve*--endpoint*' } |",
    "Select-Object ProcessId,CommandLine |",
    "ConvertTo-Json -Compress"
  ].join(" ");
  const stdout = await execFileText("powershell.exe", ["-NoProfile", "-Command", script], 10000);
  const rows = parseJsonRows(stdout);
  const targetCwd = relayTargetCwd();
  const parsed = rows
    .map((row) => parseBrokerCommandLine(row.CommandLine || ""))
    .filter((row) => row.endpoint);
  const cwdMatch = parsed.find((row) => normalizePath(row.cwd) === targetCwd);
  const chosen = cwdMatch || parsed[0];
  if (!chosen || !chosen.endpoint) {
    throw new Error("Codex app-server broker endpoint was not found");
  }
  return chosen.endpoint;
}

function appServerRequest(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(appServerConnectTarget(endpoint));
    let buffer = "";
    let initialized = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Codex app-server request timed out: ${method}`));
    }, DEFAULT_APP_SERVER_TIMEOUT_MS);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      sendAppServerMessage(socket, {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { title: "Telegram Relay", name: "codex-telegram-relay", version: SERVER_VERSION },
          capabilities: { experimentalApi: false, optOutNotificationMethods: [] }
        }
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(new Error(`Invalid Codex app-server JSON: ${error.message}`));
          return;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          sendAppServerMessage(socket, { id: 2, method, params });
          continue;
        }
        if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || `${method} failed`));
          } else {
            finish(null, message.result || {});
          }
        }
      }
    });
    socket.on("error", (error) => finish(error));
  });
}

function appServerConnectTarget(endpoint) {
  const value = String(endpoint || "");
  if (value.startsWith("pipe:")) return value.slice("pipe:".length);
  return value;
}

function sendAppServerMessage(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

module.exports = {
  startTelegramRelay,
  scheduleRelayPendingMessages,
  telegramRelayStatus,
  formatRelayPrompt,
  formatConsoleRelayPrompt,
  relayReplyInstructionLines
};
