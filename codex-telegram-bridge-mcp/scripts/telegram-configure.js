#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ENV_FILE = "config.toml.env";
const PROJECT_ACCESS_FILE = "config.toml.access.json";
const ENV_FILE = resolveEnvFile();
const CONFIG_DIR = path.dirname(ENV_FILE);
const ACCESS_FILE = resolveAccessFile();
const DISPLAY_COMMAND = process.env.CODEX_TELEGRAM_CONFIGURE_COMMAND ||
  `node ${quoteForDisplay(__filename)}`;
const PERMISSION_HOOK_SCRIPT = path.join(__dirname, "codex-permission-telegram.js");
const PAIRING_TTL_MS = normalizePairingTtl(process.env.CODEX_TELEGRAM_PAIRING_TTL_MS);

const [command, ...rest] = process.argv.slice(2);

main().catch((error) => {
  console.error(`telegram configure failed: ${sanitize(error.message)}`);
  process.exit(1);
});

async function main() {
  if (!command || command === "status") {
    showStatus();
    return;
  }

  if (command === "token") {
    const token = rest.join(" ").trim();
    await saveTokenAndCreatePairing(token);
    return;
  }

  if (command === "token-stdin") {
    const token = (await readStdin()).trim();
    await saveTokenAndCreatePairing(token);
    return;
  }

  if (command === "token-clipboard") {
    const token = (await readClipboard()).trim();
    await saveTokenAndCreatePairing(token);
    return;
  }

  if (looksLikeToken(command)) {
    await saveTokenAndCreatePairing(command);
    return;
  }

  if (command === "pair") {
    await pairChat(rest[0]);
    return;
  }

  if (command === "clear") {
    clearToken();
    showStatus();
    return;
  }

  if (command === "allow") {
    const chatId = requireArg(rest[0], "chat id");
    updateAccess((access) => {
      addUnique(access.allowFrom, String(chatId));
      access.dmPolicy = "allowlist";
    });
    showStatus();
    return;
  }

  if (command === "remove") {
    const chatId = requireArg(rest[0], "chat id");
    updateAccess((access) => {
      access.allowFrom = access.allowFrom.filter((item) => item !== String(chatId));
    });
    showStatus();
    return;
  }

  if (command === "policy") {
    const policy = requireArg(rest[0], "policy");
    if (!["allowlist", "disabled"].includes(policy)) {
      throw new Error("policy must be allowlist or disabled");
    }
    updateAccess((access) => {
      access.dmPolicy = policy;
    });
    showStatus();
    return;
  }

  if (command === "discover") {
    await discoverChats();
    return;
  }

  if (command === "hook-snippet") {
    printPermissionHookSnippet();
    return;
  }

  usage();
  process.exitCode = 2;
}

async function saveTokenAndCreatePairing(token) {
  if (!looksLikeToken(token)) {
    throw new Error("expected a Telegram bot token like 123456789:AAH...");
  }

  const bot = await telegramApi(token, "getMe", {});
  if (!bot || bot.is_bot !== true) {
    throw new Error("Telegram token did not resolve to a bot account");
  }

  const env = readEnv();
  env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
  env.TELEGRAM_BOT_TOKEN = token;
  writeEnv(env);

  const pairing = createPairing(bot);
  showStatus();
  printPairing(pairing);
}

function createPairing(bot) {
  const access = pruneExpiredPending(readAccess());
  const code = newPairingCode(access);
  const now = Date.now();
  access.pending[code] = {
    botId: bot.id ? String(bot.id) : "",
    botUsername: bot.username || "",
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS
  };
  writeAccess(access);
  return {
    code,
    botUsername: bot.username || "",
    expiresAt: access.pending[code].expiresAt
  };
}

async function pairChat(inputCode) {
  const env = readEnv();
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const access = pruneExpiredPending(readAccess());
  const code = resolvePairingCode(access, inputCode);
  const pending = access.pending[code];
  if (!pending) {
    throw new Error(`pairing code not found or expired: ${code}`);
  }

  const updates = await telegramApi(env.TELEGRAM_BOT_TOKEN, "getUpdates", {
    timeout: 0,
    limit: 100,
    allowed_updates: ["message"]
  });
  const match = findPairingMessage(updates, code, pending.botUsername);
  if (!match) {
    writeAccess(access);
    const link = pending.botUsername ? pairingLink(pending.botUsername, code) : "";
    const hint = link ? ` Open ${link}, send Start, then run pair again.` : " Send the code to the bot, then run pair again.";
    throw new Error(`No recent Telegram message contains pairing code ${code}.${hint}`);
  }

  const chatId = String(match.message.chat.id);
  addUnique(access.allowFrom, chatId);
  access.dmPolicy = "allowlist";
  delete access.pending[code];
  writeAccess(access);

  await telegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "Codex Telegram bridge paired. This chat is now allowlisted.",
    disable_web_page_preview: true
  }).catch(() => {});

  console.log(`paired_chat: ${chatId} ${displayName(match.message)}`.trim());
  showStatus();
}

function showStatus() {
  const env = readEnv();
  const access = pruneExpiredPending(readAccess());
  writeAccess(access);
  const pendingEntries = Object.entries(access.pending);

  console.log(`config_dir: ${CONFIG_DIR}`);
  console.log(`enabled: ${env.CODEX_TELEGRAM_BRIDGE_ENABLED === "1" ? "yes" : "no"}`);
  console.log(`token: ${env.TELEGRAM_BOT_TOKEN ? maskToken(env.TELEGRAM_BOT_TOKEN) : "not set"}`);
  console.log(`dmPolicy: ${access.dmPolicy}`);
  console.log(`allowed_chats: ${access.allowFrom.length}`);
  for (const chatId of access.allowFrom) {
    console.log(`- ${chatId}`);
  }
  console.log(`pending_pairings: ${pendingEntries.length}`);
  for (const [code, pending] of pendingEntries) {
    const expires = new Date(pending.expiresAt).toISOString();
    const bot = pending.botUsername ? ` @${pending.botUsername}` : "";
    console.log(`- ${code}${bot} expires ${expires}`);
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log(`next: ${commandExample("token <bot-token>")}`);
  } else if (access.allowFrom.length === 0 && pendingEntries.length > 0) {
    const [code, pending] = pendingEntries[0];
    const link = pending.botUsername ? ` Open ${pairingLink(pending.botUsername, code)} first.` : "";
    console.log(`next:${link} then run: ${commandExample(`pair ${code}`)}`);
  } else if (access.allowFrom.length === 0) {
    console.log(`next: ${commandExample("token <bot-token>")} to create a pairing link, or ${commandExample("discover")}`);
  } else if (access.dmPolicy !== "allowlist") {
    console.log(`next: ${commandExample("policy allowlist")}`);
  } else {
    console.log("ready: restart Codex so the MCP server reloads this config.");
  }
}

function printPairing(pairing) {
  console.log(`pair_code: ${pairing.code}`);
  if (pairing.botUsername) {
    console.log(`pair_link: ${pairingLink(pairing.botUsername, pairing.code)}`);
  }
  console.log(`pair_expires: ${new Date(pairing.expiresAt).toISOString()}`);
  console.log(`next: open the pair_link, send Start, then run: ${commandExample(`pair ${pairing.code}`)}`);
}

async function discoverChats() {
  const env = readEnv();
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  const result = await telegramApi(env.TELEGRAM_BOT_TOKEN, "getUpdates", {
    timeout: 0,
    limit: 100,
    allowed_updates: ["message"]
  });
  const seen = new Map();
  for (const update of result) {
    const message = update.message;
    if (!message || !message.chat) continue;
    const chatId = String(message.chat.id);
    seen.set(chatId, displayName(message) || chatId);
  }
  if (seen.size === 0) {
    console.log("No recent chats found. Create a pairing link with token <bot-token>, then open the link in Telegram.");
    return;
  }
  console.log("Recent chats:");
  for (const [chatId, label] of seen) {
    console.log(`- ${chatId} ${label}`);
  }
  console.log(`Allow one explicitly with: ${commandExample("allow <chat-id>")}`);
}

async function telegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(body.description || response.statusText);
  }
  return body.result || [];
}

function clearToken() {
  const env = readEnv();
  delete env.TELEGRAM_BOT_TOKEN;
  writeEnv(env);
  updateAccess((access) => {
    access.pending = {};
  });
}

function readAccess() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    return normalizeAccess(parsed);
  } catch {
    return defaultAccess();
  }
}

function writeAccess(access) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ACCESS_FILE, `${JSON.stringify(normalizeAccess(access), null, 2)}\n`, { mode: 0o600 });
}

function updateAccess(mutator) {
  const access = pruneExpiredPending(readAccess());
  mutator(access);
  writeAccess(access);
}

function normalizeAccess(value) {
  const access = value && typeof value === "object" ? value : {};
  return {
    ...defaultAccess(),
    ...access,
    allowFrom: Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : [],
    groups: access.groups && typeof access.groups === "object" ? access.groups : {},
    pending: access.pending && typeof access.pending === "object" ? access.pending : {}
  };
}

function defaultAccess() {
  return {
    dmPolicy: "allowlist",
    allowFrom: [],
    groups: {},
    pending: {}
  };
}

function pruneExpiredPending(access) {
  const now = Date.now();
  const next = normalizeAccess(access);
  for (const [code, pending] of Object.entries(next.pending)) {
    if (!pending || Number(pending.expiresAt || 0) <= now) {
      delete next.pending[code];
    }
  }
  return next;
}

function newPairingCode(access) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = crypto.randomBytes(3).toString("hex");
    if (!access.pending[code]) return code;
  }
  throw new Error("failed to generate a unique pairing code");
}

function resolvePairingCode(access, inputCode) {
  if (inputCode) {
    return normalizePairingCode(inputCode);
  }
  const codes = Object.keys(access.pending);
  if (codes.length === 1) return codes[0];
  if (codes.length === 0) {
    throw new Error(`no pending pairing. Run: ${commandExample("token <bot-token>")}`);
  }
  throw new Error(`multiple pending pairings. Run pair with one code: ${codes.join(", ")}`);
}

function findPairingMessage(updates, code, botUsername) {
  const normalizedCode = normalizePairingCode(code);
  const botSuffix = botUsername ? `(?:@${escapeRegex(botUsername)})?` : "(?:@[A-Za-z0-9_]+)?";
  const startPattern = new RegExp(`^\\/start${botSuffix}\\s+${escapeRegex(normalizedCode)}\\b`, "i");
  const rawPattern = new RegExp(`^${escapeRegex(normalizedCode)}$`, "i");

  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update.message;
    const text = String(message && message.text || "").trim();
    if (!message || !message.chat || !text) continue;
    if (startPattern.test(text) || rawPattern.test(text)) {
      return { update, message };
    }
  }
  return null;
}

function displayName(message) {
  const from = message.from || {};
  return [from.username && `@${from.username}`, from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");
}

function pairingLink(botUsername, code) {
  return `https://t.me/${botUsername}?start=${normalizePairingCode(code)}`;
}

function normalizePairingCode(value) {
  const code = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{6}$/.test(code)) {
    throw new Error("pairing code must be 6 hex characters");
  }
  return code;
}

function normalizePairingTtl(value) {
  const parsed = Number(value || 10 * 60 * 1000);
  if (!Number.isFinite(parsed) || parsed < 60 * 1000 || parsed > 24 * 60 * 60 * 1000) {
    return 10 * 60 * 1000;
  }
  return Math.floor(parsed);
}

function readEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch {}
  return env;
}

function writeEnv(env) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const lines = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function requireArg(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function looksLikeToken(value) {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(value || "").trim());
}

function maskToken(token) {
  const text = String(token || "");
  return `${text.slice(0, Math.min(10, text.length))}...`;
}

function sanitize(text) {
  return String(text || "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_BOT_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]");
}

function commandExample(args) {
  return `${DISPLAY_COMMAND} ${args}`;
}

function printPermissionHookSnippet() {
  const hookCommand = `node ${quoteForShell(PERMISSION_HOOK_SCRIPT)}`;
  console.log([
    "[features]",
    "codex_hooks = true",
    "",
    "[[hooks.PermissionRequest]]",
    'matcher = "*"',
    "",
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(hookCommand)}`,
    "timeout = 330",
    'statusMessage = "Waiting for Telegram approval"'
  ].join("\n"));
}

function quoteForDisplay(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text}"` : text;
}

function quoteForShell(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function usage() {
  console.log([
    "Usage:",
    `  ${commandExample("status")}`,
    `  ${commandExample("token <bot-token>")}`,
    `  ${commandExample("token-stdin")}`,
    `  ${commandExample("token-clipboard")}`,
    `  ${commandExample("pair [code]")}`,
    `  ${commandExample("discover")}`,
    `  ${commandExample("allow <chat-id>")}`,
    `  ${commandExample("remove <chat-id>")}`,
    `  ${commandExample("policy allowlist|disabled")}`,
    `  ${commandExample("hook-snippet")}`,
    `  ${commandExample("clear")}`
  ].join("\n"));
}

function resolveEnvFile() {
  const configured = process.env.CODEX_TELEGRAM_BRIDGE_ENV_FILE ||
    process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_FILE;
  if (configured) return configured;

  const projectFile = path.join(process.cwd(), ".codex", PROJECT_ENV_FILE);
  if (fs.existsSync(projectFile)) return projectFile;

  const configuredDir = process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_DIR ||
    process.env.CODEX_TELEGRAM_BRIDGE_STATE_DIR;
  if (configuredDir) return path.join(configuredDir, ".env");

  return path.join(os.homedir(), ".codex", "channels", "telegram", ".env");
}

function resolveAccessFile() {
  if (process.env.CODEX_TELEGRAM_BRIDGE_ACCESS_FILE) {
    return process.env.CODEX_TELEGRAM_BRIDGE_ACCESS_FILE;
  }

  const configuredDir = process.env.CODEX_TELEGRAM_BRIDGE_CONFIG_DIR ||
    process.env.CODEX_TELEGRAM_BRIDGE_STATE_DIR;
  if (configuredDir) return path.join(configuredDir, "access.json");

  if (path.basename(ENV_FILE).toLowerCase() === PROJECT_ENV_FILE) {
    return path.join(path.dirname(ENV_FILE), PROJECT_ACCESS_FILE);
  }

  return path.join(CONFIG_DIR, "access.json");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

function readClipboard() {
  if (process.platform !== "win32") {
    throw new Error("token-clipboard is currently supported on Windows only. Use token-stdin instead.");
  }
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Clipboard"],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 64 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || "failed to read clipboard"));
          return;
        }
        resolve(stdout || "");
      }
    );
  });
}
