"use strict";

const crypto = require("node:crypto");
const {
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  APPROVE_TOKENS,
  DENY_TOKENS
} = require("./constants.js");
const {
  monitorPollTimeoutSec,
  monitorBackoffMs,
  inboxMaxMessages,
  telegramEnabled,
  allowedChatIds,
  assertTelegram,
  bridgeEnabled
} = require("./config.js");
const { readTelegramState, writeTelegramState } = require("./state.js");
const { normalizeTimeout, normalizeInteger, delay, sanitize } = require("./util.js");

let monitorStarted = false;
let monitorRunning = false;
let monitorLastPollAt = "";
let monitorLastError = "";
let monitorLastErrorAt = "";
let pollInFlight = null;
const inboxWaiters = new Set();
let relayHooks = {
  start: () => {},
  schedule: () => {}
};

function setRelayHooks(hooks) {
  relayHooks = {
    start: typeof hooks.start === "function" ? hooks.start : relayHooks.start,
    schedule: typeof hooks.schedule === "function" ? hooks.schedule : relayHooks.schedule
  };
}

async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`Telegram API failed: ${sanitize(body.description || response.statusText)}`);
  }
  return body.result;
}

async function telegramSend(args) {
  assertTelegram(args.chatId);
  const text = sanitize(args.text);
  if (!text) throw new Error("text is required");
  await telegramApi("sendMessage", {
    chat_id: args.chatId,
    text,
    disable_web_page_preview: Boolean(args.disableWebPagePreview)
  });
  return `telegram sent to ${args.chatId}`;
}

async function telegramWaitReply(args) {
  assertTelegram(args.chatId);
  startTelegramMonitor();
  const timeoutMs = normalizeTimeout(args.timeoutMs, DEFAULT_TELEGRAM_TIMEOUT_MS);

  if (args.ignoreExisting !== false) {
    await telegramSyncOffset();
    clearInboxForChat(args.chatId);
  }

  const existing = takeFirstInboxMessage(args.chatId, true);
  if (existing) {
    return formatReply(existing);
  }

  return formatReply(await waitForInboxMessage(args.chatId, timeoutMs));
}

async function telegramSyncOffset() {
  await withPollLock(async () => {
    for (let drainCount = 0; drainCount < 100; drainCount += 1) {
      const updates = await fetchTelegramUpdates(0);
      const state = readTelegramState();
      advanceUpdateOffset(state, updates);
      writeTelegramState(state);
      if (!Array.isArray(updates) || updates.length < 100) break;
    }
  });
}

async function telegramAsk(args) {
  assertTelegram(args.chatId);
  startTelegramMonitor();
  await telegramSyncOffset();
  clearInboxForChat(args.chatId);
  await telegramSend(args);
  return telegramWaitReply({ ...args, ignoreExisting: false });
}

async function telegramInboxRead(args) {
  if (!bridgeEnabled()) {
    throw new Error("Telegram bridge is disabled. Set CODEX_TELEGRAM_BRIDGE_ENABLED=1.");
  }
  startTelegramMonitor();
  const limit = normalizeInteger(args.limit, 20, 1, 100);
  const consume = Boolean(args.consume);
  const chatId = args.chatId ? String(args.chatId) : "";
  if (chatId) assertTelegram(chatId);

  const allowed = allowedChatIds();
  const state = readTelegramState();
  const messages = state.inbox
    .filter((message) => (!chatId || message.chatId === chatId) && allowed.has(message.chatId))
    .slice(0, limit);

  if (consume && messages.length > 0) {
    const consumed = new Set(messages.map((message) => message.id));
    state.inbox = state.inbox.filter((message) => !consumed.has(message.id));
    writeTelegramState(state);
  }

  if (messages.length === 0) {
    return "telegram inbox: 0 messages";
  }

  return [
    `telegram inbox: ${messages.length} message(s)${consume ? " consumed" : ""}`,
    ...messages.map(formatInboxLine)
  ].join("\n");
}

async function telegramMonitorStatus() {
  const state = readTelegramState();
  const allowed = allowedChatIds();
  const perChat = new Map();
  for (const message of state.inbox) {
    perChat.set(message.chatId, (perChat.get(message.chatId) || 0) + 1);
  }

  return [
    `telegram_monitor: ${monitorStarted ? "started" : "stopped"}`,
    `running: ${monitorRunning ? "yes" : "no"}`,
    `configured: ${telegramEnabled() ? "yes" : "no"}`,
    `update_offset: ${state.updateOffset || 0}`,
    `inbox_messages: ${state.inbox.length}`,
    `allowed_chats: ${allowed.size}`,
    `last_poll_at: ${monitorLastPollAt || "never"}`,
    `last_error: ${monitorLastError || "none"}`,
    ...Array.from(perChat.entries()).map(([chatId, count]) => `- ${chatId}: ${count}`)
  ].join("\n");
}

async function telegramApprovalRequest(args) {
  assertTelegram(args.chatId);
  startTelegramMonitor();
  const timeoutMs = normalizeTimeout(args.timeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
  const code = crypto.randomBytes(3).toString("hex");
  const title = sanitize(args.title);
  const message = sanitize(args.message);
  const chatId = String(args.chatId);

  await telegramSyncOffset();
  clearInboxForChat(chatId);
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: [
      "Approval request / 승인 요청",
      "",
      title,
      "",
      message,
      "",
      `Code / 코드: ${code}`,
      "Approve: choose or type 'approve' or '승인'.",
      "Deny: choose or type 'deny' or '거부'."
    ].join("\n"),
    disable_web_page_preview: true,
    reply_markup: {
      keyboard: [[`approve ${code}`, `deny ${code}`]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1000, deadline - Date.now());
    const reply = await waitForInboxMessage(chatId, remaining).catch((error) => {
      if (/Timed out waiting/.test(error.message || "")) return null;
      throw error;
    });
    if (!reply) break;

    const decision = parseApprovalDecision(reply.text, code);
    if (decision) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: decision === "approved" ? "Approved / 승인 처리되었습니다." : "Denied / 거부 처리되었습니다.",
        disable_web_page_preview: true,
        reply_markup: { remove_keyboard: true }
      }).catch(() => {});
      return [
        `approval: ${decision}`,
        `chat_id: ${chatId}`,
        `code: ${code}`,
        `reply: ${sanitize(reply.text)}`
      ].join("\n");
    }
  }

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "Approval request timed out / 승인 요청 시간이 만료되었습니다.",
    disable_web_page_preview: true,
    reply_markup: { remove_keyboard: true }
  }).catch(() => {});
  return [`approval: timeout`, `chat_id: ${chatId}`, `code: ${code}`].join("\n");
}

function startTelegramMonitor() {
  if (monitorStarted || process.env.CODEX_TELEGRAM_MONITOR_ENABLED === "0") return;
  if (!telegramEnabled()) return;
  monitorStarted = true;
  relayHooks.start();
  void telegramMonitorLoop();
}

async function telegramMonitorLoop() {
  while (monitorStarted) {
    if (!telegramEnabled()) {
      monitorRunning = false;
      await delay(monitorBackoffMs());
      continue;
    }

    monitorRunning = true;
    try {
      await pollAndStoreTelegramUpdates(monitorPollTimeoutSec());
      monitorLastError = "";
    } catch (error) {
      monitorLastError = sanitize(error.message || "monitor error");
      monitorLastErrorAt = new Date().toISOString();
      await delay(monitorBackoffMs());
    }
  }
  monitorRunning = false;
}

async function pollAndStoreTelegramUpdates(timeoutSeconds) {
  await withPollLock(async () => {
    const updates = await fetchTelegramUpdates(timeoutSeconds);
    const state = readTelegramState();
    advanceUpdateOffset(state, updates);
    appendAllowedMessages(state, updates);
    state.lastPollAt = new Date().toISOString();
    monitorLastPollAt = state.lastPollAt;
    if (monitorLastErrorAt) state.lastErrorAt = monitorLastErrorAt;
    writeTelegramState(state);
    notifyInboxWaiters();
  });
  relayHooks.schedule();
}

async function withPollLock(work) {
  while (pollInFlight) {
    await pollInFlight.catch(() => {});
  }
  const current = Promise.resolve().then(work);
  pollInFlight = current;
  try {
    return await current;
  } finally {
    if (pollInFlight === current) {
      pollInFlight = null;
    }
  }
}

async function fetchTelegramUpdates(timeoutSeconds) {
  return telegramApi("getUpdates", {
    offset: Number(readTelegramState().updateOffset || 0),
    timeout: timeoutSeconds,
    limit: 100,
    allowed_updates: ["message"]
  });
}

function advanceUpdateOffset(state, updates) {
  for (const update of Array.isArray(updates) ? updates : []) {
    if (Number.isFinite(update.update_id)) {
      state.updateOffset = Math.max(Number(state.updateOffset || 0), update.update_id + 1);
    }
  }
}

function appendAllowedMessages(state, updates) {
  const allowed = allowedChatIds();
  const seen = new Set(state.inbox.map((message) => message.id));
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update.message;
    const chatId = message && message.chat && String(message.chat.id);
    const text = message && typeof message.text === "string" ? sanitize(message.text) : "";
    if (!chatId || !text || !allowed.has(chatId)) continue;
    const id = `${update.update_id}:${message.message_id || 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    state.inbox.push({
      id,
      updateId: Number(update.update_id || 0),
      messageId: Number(message.message_id || 0),
      chatId,
      text,
      date: message.date ? new Date(Number(message.date) * 1000).toISOString() : "",
      receivedAt: new Date().toISOString(),
      from: displayName(message)
    });
  }
  if (state.inbox.length > inboxMaxMessages()) {
    state.inbox = state.inbox.slice(-inboxMaxMessages());
  }
}

function takeFirstInboxMessage(chatId, consume) {
  const state = readTelegramState();
  const index = state.inbox.findIndex((message) => message.chatId === String(chatId));
  if (index < 0) return null;
  const [message] = consume ? state.inbox.splice(index, 1) : [state.inbox[index]];
  if (consume) writeTelegramState(state);
  return message;
}

function clearInboxForChat(chatId) {
  const state = readTelegramState();
  const before = state.inbox.length;
  state.inbox = state.inbox.filter((message) => message.chatId !== String(chatId));
  if (state.inbox.length !== before) writeTelegramState(state);
}

function waitForInboxMessage(chatId, timeoutMs) {
  const existing = takeFirstInboxMessage(chatId, true);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const waiter = {
      chatId: String(chatId),
      resolve,
      reject,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      inboxWaiters.delete(waiter);
      reject(new Error(`Timed out waiting for Telegram reply after ${timeoutMs}ms`));
    }, timeoutMs);
    inboxWaiters.add(waiter);
    notifyInboxWaiters();
  });
}

function notifyInboxWaiters() {
  for (const waiter of Array.from(inboxWaiters)) {
    const message = takeFirstInboxMessage(waiter.chatId, true);
    if (!message) continue;
    clearTimeout(waiter.timer);
    inboxWaiters.delete(waiter);
    waiter.resolve(message);
  }
}

function formatReply(message) {
  return `telegram reply from ${message.chatId}:\n${sanitize(message.text)}`;
}

function formatInboxLine(message) {
  const when = message.date || message.receivedAt || "";
  const from = message.from ? ` ${message.from}` : "";
  return `[${when}] ${message.chatId}${from}: ${sanitize(message.text)}`;
}

function parseApprovalDecision(text, code) {
  const normalized = String(text || "").trim().toLowerCase();
  const withoutCode = normalized.replace(String(code).toLowerCase(), "").trim();
  const firstToken = withoutCode.split(/\s+/).filter(Boolean)[0] || withoutCode;
  if (APPROVE_TOKENS.has(normalized) || APPROVE_TOKENS.has(withoutCode) || APPROVE_TOKENS.has(firstToken)) {
    return "approved";
  }
  if (DENY_TOKENS.has(normalized) || DENY_TOKENS.has(withoutCode) || DENY_TOKENS.has(firstToken)) {
    return "denied";
  }
  return "";
}

function displayName(message) {
  const from = message.from || {};
  return [from.username && `@${from.username}`, from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");
}

module.exports = {
  setRelayHooks,
  telegramSend,
  telegramWaitReply,
  telegramAsk,
  telegramInboxRead,
  telegramMonitorStatus,
  telegramApprovalRequest,
  startTelegramMonitor,
  telegramApi
};
