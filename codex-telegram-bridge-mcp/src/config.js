"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PROJECT_ENV_FILE,
  PROJECT_ACCESS_FILE,
  DEFAULT_MONITOR_POLL_TIMEOUT_SEC,
  DEFAULT_MONITOR_BACKOFF_MS,
  DEFAULT_INBOX_MAX_MESSAGES
} = require("./constants.js");
const { normalizeInteger, normalizePath } = require("./util.js");

function monitorPollTimeoutSec() {
  return normalizeInteger(process.env.CODEX_TELEGRAM_MONITOR_POLL_TIMEOUT_SEC, DEFAULT_MONITOR_POLL_TIMEOUT_SEC, 1, 50);
}

function monitorBackoffMs() {
  return normalizeInteger(process.env.CODEX_TELEGRAM_MONITOR_BACKOFF_MS, DEFAULT_MONITOR_BACKOFF_MS, 1000, 60000);
}

function inboxMaxMessages() {
  return normalizeInteger(process.env.CODEX_TELEGRAM_INBOX_MAX_MESSAGES, DEFAULT_INBOX_MAX_MESSAGES, 20, 2000);
}

function relayEnabled() {
  return true;
}

function relayMode() {
  const configured = String(process.env.CODEX_TELEGRAM_CODEX_RELAY_MODE || "").trim().toLowerCase();
  if (configured === "app-server" || configured === "appserver") return "app-server";
  if (configured === "console" || configured === "") return "console";
  return "console";
}

function relayIgnoreExisting() {
  return process.env.CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING !== "0";
}

function relayTargetThreadId() {
  return String(process.env.CODEX_TELEGRAM_CODEX_THREAD_ID || process.env.CODEX_THREAD_ID || "").trim();
}

function relayTargetCwd() {
  return normalizePath(process.env.CODEX_TELEGRAM_CODEX_CWD || process.cwd());
}

function relayConsolePid() {
  return String(process.env.CODEX_TELEGRAM_CODEX_CONSOLE_PID || "").trim();
}

function relayConsoleSubmitDelayMs() {
  return normalizeInteger(process.env.CODEX_TELEGRAM_CODEX_SUBMIT_DELAY_MS, 150, 0, 5000);
}

function relayReplyRequired() {
  return true;
}

function telegramEnabled() {
  return bridgeEnabled() &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    allowedChatIds().size > 0;
}

function allowedChatIds() {
  const configured = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const access = readAccess();
  return new Set([...configured, ...access.allowFrom]);
}

function assertTelegram(chatId) {
  if (!bridgeEnabled()) {
    throw new Error("Telegram bridge is disabled. Set CODEX_TELEGRAM_BRIDGE_ENABLED=1.");
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }
  const allowed = allowedChatIds();
  if (!allowed.has(String(chatId))) {
    throw new Error("chatId is not allowlisted in TELEGRAM_ALLOWED_CHAT_IDS.");
  }
}

function bridgeEnabled() {
  return process.env.CODEX_TELEGRAM_BRIDGE_ENABLED === "1";
}

function telegramConfigDir() {
  const configured = process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_DIR ||
    process.env.CODEX_TELEGRAM_BRIDGE_STATE_DIR;
  if (configured) return configured;
  return path.dirname(telegramEnvPath());
}

function telegramEnvPath() {
  const configured = process.env.CODEX_TELEGRAM_BRIDGE_ENV_FILE ||
    process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_FILE;
  if (configured) return configured;

  const projectFile = projectTelegramEnvPath();
  if (fs.existsSync(projectFile)) return projectFile;

  return path.join(userTelegramConfigDir(), ".env");
}

function telegramAccessPath() {
  if (process.env.CODEX_TELEGRAM_BRIDGE_ACCESS_FILE) {
    return process.env.CODEX_TELEGRAM_BRIDGE_ACCESS_FILE;
  }

  const configured = process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_DIR ||
    process.env.CODEX_TELEGRAM_BRIDGE_STATE_DIR;
  if (configured) return path.join(configured, "access.json");

  const envFile = telegramEnvPath();
  if (path.basename(envFile).toLowerCase() === PROJECT_ENV_FILE) {
    return path.join(path.dirname(envFile), PROJECT_ACCESS_FILE);
  }

  return path.join(userTelegramConfigDir(), "access.json");
}

function userTelegramConfigDir() {
  return path.join(os.homedir(), ".codex", "channels", "telegram");
}

function projectTelegramEnvPath() {
  return path.join(process.cwd(), ".codex", PROJECT_ENV_FILE);
}

function loadEnvFiles() {
  for (const file of telegramEnvPathsToLoad()) {
    loadEnvFile(file);
  }
}

function telegramEnvPathsToLoad() {
  const configured = process.env.CODEX_TELEGRAM_BRIDGE_ENV_FILE ||
    process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_FILE;
  if (configured) return [configured];

  const projectFile = projectTelegramEnvPath();
  if (fs.existsSync(projectFile)) return [projectFile];

  return [path.join(userTelegramConfigDir(), ".env")];
}

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Missing config is handled by health checks and tool preconditions.
  }
}

function defaultAccess() {
  return {
    dmPolicy: "allowlist",
    allowFrom: [],
    groups: {}
  };
}

function readAccess() {
  try {
    const parsed = JSON.parse(fs.readFileSync(telegramAccessPath(), "utf8"));
    return {
      ...defaultAccess(),
      ...parsed,
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom.map(String) : [],
      groups: parsed.groups && typeof parsed.groups === "object" ? parsed.groups : {}
    };
  } catch {
    return defaultAccess();
  }
}

function telegramStatePath() {
  const configured = process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE;
  if (configured) return configured;
  const dir = process.env.CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR ||
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CodexTelegramBridge", "codex-telegram-bridge-mcp");
  return path.join(dir, "telegram-state.json");
}

loadEnvFiles();

module.exports = {
  monitorPollTimeoutSec,
  monitorBackoffMs,
  inboxMaxMessages,
  relayEnabled,
  relayMode,
  relayIgnoreExisting,
  relayTargetThreadId,
  relayTargetCwd,
  relayConsolePid,
  relayConsoleSubmitDelayMs,
  relayReplyRequired,
  telegramEnabled,
  allowedChatIds,
  assertTelegram,
  bridgeEnabled,
  telegramConfigDir,
  telegramEnvPath,
  telegramAccessPath,
  telegramStatePath
};
