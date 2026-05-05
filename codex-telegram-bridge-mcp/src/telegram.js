"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS
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
const {
  readTelegramState,
  writeTelegramState,
  withTelegramStateLock,
  withTelegramUpdateLock
} = require("./state.js");
const { normalizeTimeout, normalizeInteger, delay, sanitize } = require("./util.js");
const {
  approvalRequestText,
  parseApprovalCallbackData,
  parseApprovalDecision
} = require("./approval.js");
const {
  choiceReplyMarkup,
  choiceSelectionText,
  createChoiceRequestId,
  findChoiceByText,
  normalizeChoices,
  parseChoiceCallbackData,
  selectedChoiceResult,
  timeoutChoiceResult
} = require("./choices.js");

let monitorStarted = false;
let monitorRunning = false;
let monitorLastPollAt = "";
let monitorLastError = "";
let monitorLastErrorAt = "";
let pollInFlight = null;
const inboxWaiters = new Set();
const choiceWaiters = new Set();
let relayHooks = {
  start: () => {},
  schedule: () => {}
};
const MAX_LOCAL_UPLOAD_BYTES = 50 * 1024 * 1024;

function setRelayHooks(hooks) {
  relayHooks = {
    start: typeof hooks.start === "function" ? hooks.start : relayHooks.start,
    schedule: typeof hooks.schedule === "function" ? hooks.schedule : relayHooks.schedule
  };
}

async function telegramApiRequest(method, body, multipart = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const request = multipart
    ? { method: "POST", body }
    : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {})
      };
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, request);
  const resultBody = await response.json().catch(() => ({}));
  if (!response.ok || resultBody.ok !== true) {
    throw new Error(`Telegram API failed: ${sanitize(resultBody.description || response.statusText)}`);
  }
  return resultBody.result;
}

async function telegramApi(method, payload) {
  return telegramApiRequest(method, payload, false);
}

async function telegramApiMultipart(method, formData) {
  return telegramApiRequest(method, formData, true);
}

async function telegramSend(args) {
  const chatId = resolveChatId(args.chatId);
  assertTelegram(chatId);
  const text = sanitize(args.text);
  if (!text) throw new Error("text is required");
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: Boolean(args.disableWebPagePreview)
  });
  return `telegram sent to ${chatId}`;
}

async function telegramSendPhoto(args) {
  return JSON.stringify(await telegramSendMedia({
    args,
    type: "photo",
    method: "sendPhoto",
    field: "photo"
  }), null, 2);
}

async function telegramSendFile(args) {
  return JSON.stringify(await telegramSendMedia({
    args,
    type: "file",
    method: "sendDocument",
    field: "document"
  }), null, 2);
}

async function telegramSendDocument(args) {
  return JSON.stringify(await telegramSendMedia({
    args,
    type: "document",
    method: "sendDocument",
    field: "document"
  }), null, 2);
}

async function telegramSendMedia({ args, type, method, field }) {
  const chatId = resolveChatId(args.chatId);
  assertTelegram(chatId);
  const source = resolveMediaSource(args);
  const caption = mediaCaption(args.caption);

  const common = {
    chat_id: chatId
  };
  if (caption) common.caption = caption;
  if (args.disableNotification === true) common.disable_notification = true;
  if (args.protectContent === true) common.protect_content = true;

  let result;
  let fileName = "";
  let fileSize = null;
  if (source.kind === "path") {
    const local = await prepareLocalUpload(source.value, args.filename);
    const form = new FormData();
    for (const [key, value] of Object.entries(common)) {
      form.append(key, String(value));
    }
    form.append(field, local.blob, local.fileName);
    result = await telegramApiMultipart(method, form);
    fileName = local.fileName;
    fileSize = local.fileSize;
  } else {
    result = await telegramApi(method, {
      ...common,
      [field]: source.value
    });
    fileName = source.kind === "url" ? path.posix.basename(new URL(source.value).pathname) : "";
  }

  const response = {
    status: "sent",
    type,
    source: source.kind,
    chatId,
    messageId: result && result.message_id !== undefined ? Number(result.message_id) : 0,
    timestamp: new Date().toISOString()
  };
  if (fileName) response.fileName = fileName;
  if (source.kind === "path") response.fileSize = fileSize;
  return response;
}

async function telegramWaitReply(args) {
  const chatId = resolveChatId(args.chatId);
  assertTelegram(chatId);
  startTelegramMonitor();
  const timeoutMs = normalizeTimeout(args.timeoutMs, DEFAULT_TELEGRAM_TIMEOUT_MS);

  if (args.ignoreExisting !== false) {
    await telegramSyncOffset();
    clearInboxForChat(chatId);
  }

  const existing = takeFirstInboxMessage(chatId, true);
  if (existing) {
    return formatReply(existing);
  }

  return formatReply(await waitForInboxMessage(chatId, timeoutMs));
}

function resolveMediaSource(args) {
  const sources = [
    args.path !== undefined && args.path !== null && String(args.path).trim()
      ? { kind: "path", value: String(args.path).trim() }
      : null,
    args.url !== undefined && args.url !== null && String(args.url).trim()
      ? { kind: "url", value: normalizeMediaUrl(args.url) }
      : null,
    args.fileId !== undefined && args.fileId !== null && String(args.fileId).trim()
      ? { kind: "file_id", value: String(args.fileId).trim() }
      : null
  ].filter(Boolean);
  if (sources.length === 0) throw new Error("one of path, url, or fileId is required");
  if (sources.length > 1) throw new Error("only one of path, url, or fileId may be provided");
  return sources[0];
}

function normalizeMediaUrl(value) {
  const text = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("url must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must be a valid http or https URL");
  }
  return parsed.toString();
}

function mediaCaption(value) {
  if (value === undefined || value === null) return "";
  const caption = sanitize(value);
  if (caption.length > 1024) {
    throw new Error("caption is too long; Telegram captions support up to 1024 characters");
  }
  return caption;
}

async function prepareLocalUpload(filePath, filename) {
  const resolved = path.resolve(String(filePath || ""));
  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    throw new Error(`file does not exist: ${sanitize(resolved)}`);
  }
  if (!stat.isFile()) {
    throw new Error(`path is not a file: ${sanitize(resolved)}`);
  }
  if (stat.size > MAX_LOCAL_UPLOAD_BYTES) {
    throw new Error(`file is too large for local upload: ${stat.size} bytes, max ${MAX_LOCAL_UPLOAD_BYTES} bytes`);
  }
  const content = await fs.promises.readFile(resolved);
  return {
    blob: new Blob([content], { type: mimeTypeForPath(resolved) }),
    fileName: safeFileName(filename || path.basename(resolved)),
    fileSize: stat.size
  };
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".apk": "application/vnd.android.package-archive"
  };
  return types[ext] || "application/octet-stream";
}

function safeFileName(value) {
  const name = String(value || "")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .trim()
    .slice(0, 240);
  return name || "upload";
}

async function telegramSyncOffset() {
  await withPollLock(async () => {
    for (let drainCount = 0; drainCount < 100; drainCount += 1) {
      const updates = await fetchTelegramUpdates(0);
      if (!Array.isArray(updates) || updates.length < 100) break;
    }
  });
}

async function telegramAsk(args) {
  const chatId = resolveChatId(args.chatId);
  const text = telegramAskText(args);
  const timeoutMs = normalizeTimeout(args.timeoutMs || args.timeout, DEFAULT_TELEGRAM_TIMEOUT_MS);
  const choices = normalizeChoices(args.choices || args.options);
  assertTelegram(chatId);
  startTelegramMonitor();
  await telegramSyncOffset();
  clearInboxForChat(chatId);

  if (choices.length === 0) {
    await telegramSend({ ...args, chatId, text });
    return telegramWaitReply({ ...args, chatId, timeoutMs, ignoreExisting: false });
  }

  const requestId = createChoiceRequestId();
  const sent = await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: Boolean(args.disableWebPagePreview),
    reply_markup: choiceReplyMarkup(requestId, choices)
  });
  const result = await waitForChoiceResponse({
    chatId,
    messageId: sent && sent.message_id,
    question: text,
    choices,
    requestId,
    timeoutMs
  });
  return JSON.stringify(result, null, 2);
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
  const timeoutMs = normalizeTimeout(args.timeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
  const title = sanitize(args.title);
  const message = sanitize(args.message);
  const chatId = String(args.chatId);

  const rawResult = await telegramAsk({
    chatId,
    text: approvalRequestText({ title, message }),
    choices: [
      { label: "승인", value: "approve" },
      { label: "항상 승인", value: "always approve" },
      { label: "거부", value: "deny" }
    ],
    timeoutMs,
    disableWebPagePreview: true
  });
  const result = JSON.parse(rawResult);
  if (result.timeout) {
    return [`approval: timeout`, `chat_id: ${chatId}`].join("\n");
  }

  const decision = parseApprovalDecision(result.selected_value || result.selected_label, "");
  if (!decision) return [`approval: unknown`, `chat_id: ${chatId}`].join("\n");
  return [
    `approval: ${decision}`,
    `chat_id: ${chatId}`,
    `source: ${sanitize(result.source || "")}`
  ].filter(Boolean).join("\n");
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
  await withPollLock(() => pollAndProcessTelegramUpdates(timeoutSeconds));
  relayHooks.schedule();
}

async function pollAndProcessTelegramUpdates(timeoutSeconds) {
  const updates = await fetchTelegramUpdates(timeoutSeconds);
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    advanceUpdateOffset(state, updates);
    appendAllowedMessages(state, updates);
    appendApprovalCallbackMessages(state, updates);
    state.lastPollAt = new Date().toISOString();
    monitorLastPollAt = state.lastPollAt;
    if (monitorLastErrorAt) state.lastErrorAt = monitorLastErrorAt;
    writeTelegramState(state);
  });
  await processChoiceCallbacks(updates);
  notifyChoiceWaiters();
  notifyInboxWaiters();
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
  return withTelegramUpdateLock(async () => {
    const offset = await readUpdateOffset();
    const updates = await telegramApi("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      limit: 100,
      allowed_updates: ["message", "callback_query"]
    });
    await withTelegramStateLock(async () => {
      const state = readTelegramState();
      advanceUpdateOffset(state, updates);
      writeTelegramState(state);
    });
    return updates;
  });
}

async function readUpdateOffset() {
  return withTelegramStateLock(async () => {
    return Number(readTelegramState().updateOffset || 0);
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
      userId: message.from && message.from.id !== undefined ? String(message.from.id) : "",
      from: displayName(message)
    });
  }
  if (state.inbox.length > inboxMaxMessages()) {
    state.inbox = state.inbox.slice(-inboxMaxMessages());
  }
}

function appendApprovalCallbackMessages(state, updates) {
  const allowed = allowedChatIds();
  const seen = new Set(state.inbox.map((message) => message.id));
  for (const update of Array.isArray(updates) ? updates : []) {
    const callback = update.callback_query;
    const parsed = callback && parseApprovalCallbackData(callback.data);
    const rawMessage = callback && callback.message;
    const chatId = rawMessage && rawMessage.chat && String(rawMessage.chat.id);
    if (!parsed || !chatId || !allowed.has(chatId)) continue;
    const id = `${Number(update.update_id || 0)}:callback:${String(callback.id || "")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    state.inbox.push({
      id,
      updateId: Number(update.update_id || 0),
      messageId: Number(rawMessage.message_id || 0),
      chatId,
      text: approvalInboxText(parsed),
      date: rawMessage.date ? new Date(Number(rawMessage.date) * 1000).toISOString() : "",
      receivedAt: new Date().toISOString(),
      userId: callback.from && callback.from.id !== undefined ? String(callback.from.id) : "",
      from: displayName(rawMessage)
    });
    answerChoiceCallback(callback.id, approvalCallbackAnswerText(parsed.decision)).catch(() => {});
  }
  if (state.inbox.length > inboxMaxMessages()) {
    state.inbox = state.inbox.slice(-inboxMaxMessages());
  }
}

function approvalInboxText(parsed) {
  if (parsed.decision === "always_approved") return `always approve ${parsed.code}`;
  return `${parsed.decision === "approved" ? "approve" : "deny"} ${parsed.code}`;
}

function approvalCallbackAnswerText(decision) {
  if (decision === "always_approved") return "항상 승인 선택됨";
  return decision === "approved" ? "승인 선택됨" : "거부 선택됨";
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

function resolveChatId(chatId) {
  if (chatId !== undefined && chatId !== null && String(chatId).trim()) {
    return String(chatId).trim();
  }
  if (!bridgeEnabled()) {
    throw new Error("Telegram bridge is disabled. Set CODEX_TELEGRAM_BRIDGE_ENABLED=1.");
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }
  const allowed = Array.from(allowedChatIds());
  if (allowed.length === 1) return allowed[0];
  if (allowed.length === 0) throw new Error("no Telegram chat is allowlisted.");
  throw new Error("chatId is required when multiple Telegram chats are allowlisted.");
}

function telegramAskText(args) {
  const text = sanitize(args.text || args.message || args.question);
  if (!text) throw new Error("text, message, or question is required");
  return text;
}

function waitForChoiceResponse({ chatId, messageId, question, choices, requestId, timeoutMs }) {
  return new Promise((resolve) => {
    const waiter = {
      chatId: String(chatId),
      messageId: Number(messageId || 0),
      question,
      choices,
      requestId,
      resolve,
      done: false,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      settleChoiceWaiter(waiter, timeoutChoiceResult({ chatId, messageId, requestId }));
    }, timeoutMs);
    choiceWaiters.add(waiter);
    notifyChoiceWaiters();
    void pollChoiceUntilSettled(waiter);
  });
}

async function pollChoiceUntilSettled(waiter) {
  while (!waiter.done) {
    try {
      await withPollLock(() => pollAndProcessTelegramUpdates(2));
    } catch {
      await delay(1000);
    }
    if (!waiter.done) await delay(100);
  }
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

function notifyChoiceWaiters() {
  for (const waiter of Array.from(choiceWaiters)) {
    if (waiter.done) continue;
    const message = takeMatchingChoiceMessage(waiter);
    if (!message) continue;
    const choice = findChoiceByText(waiter.choices, message.text);
    settleChoiceWaiter(waiter, selectedChoiceResult({
      choice,
      chatId: message.chatId,
      messageId: waiter.messageId || message.messageId,
      userId: message.userId,
      timestamp: message.receivedAt || message.date,
      source: "text",
      requestId: waiter.requestId
    }));
  }
}

function takeMatchingChoiceMessage(waiter) {
  const state = readTelegramState();
  const index = state.inbox.findIndex((message) => {
    return message.chatId === waiter.chatId && Boolean(findChoiceByText(waiter.choices, message.text));
  });
  if (index < 0) return null;
  const [message] = state.inbox.splice(index, 1);
  writeTelegramState(state);
  return message;
}

async function processChoiceCallbacks(updates) {
  for (const update of Array.isArray(updates) ? updates : []) {
    const callback = update.callback_query;
    if (!callback) continue;
    const parsed = parseChoiceCallbackData(callback.data);
    if (!parsed) continue;

    const waiter = findChoiceWaiter(parsed.requestId, callback);
    if (!waiter || waiter.done) {
      await answerChoiceCallback(callback.id, "선택이 이미 처리되었거나 만료되었습니다.");
      continue;
    }

    const choice = waiter.choices[parsed.index];
    if (!choice) {
      await answerChoiceCallback(callback.id, "알 수 없는 선택입니다.");
      continue;
    }

    await answerChoiceCallback(callback.id, `선택됨: ${choice.label}`);
    await updateChoiceMessage(callback, waiter.question, choice.label);
    settleChoiceWaiter(waiter, selectedChoiceResult({
      choice,
      chatId: callback.message && callback.message.chat && callback.message.chat.id,
      messageId: callback.message && callback.message.message_id,
      userId: callback.from && callback.from.id,
      timestamp: new Date().toISOString(),
      source: "button",
      requestId: waiter.requestId
    }));
  }
}

function findChoiceWaiter(requestId, callback) {
  const chatId = callback && callback.message && callback.message.chat && String(callback.message.chat.id);
  const messageId = callback && callback.message && Number(callback.message.message_id || 0);
  return Array.from(choiceWaiters).find((waiter) => {
    return waiter.requestId === requestId &&
      (!chatId || waiter.chatId === chatId) &&
      (!messageId || !waiter.messageId || waiter.messageId === messageId);
  }) || null;
}

async function answerChoiceCallback(callbackQueryId, text) {
  if (!callbackQueryId) return;
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  }).catch(() => {});
}

async function updateChoiceMessage(callback, question, label) {
  const message = callback && callback.message;
  const chatId = message && message.chat && message.chat.id;
  const messageId = message && message.message_id;
  if (!chatId || !messageId) return;
  const updated = await telegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: choiceSelectionText(question, label),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] }
  }).then(() => true).catch(() => false);
  if (updated) return;
  await telegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
  await telegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId
  }).catch(() => {});
}

function settleChoiceWaiter(waiter, result) {
  if (waiter.done) return;
  waiter.done = true;
  clearTimeout(waiter.timer);
  choiceWaiters.delete(waiter);
  waiter.resolve(result);
}

function formatReply(message) {
  return `telegram reply from ${message.chatId}:\n${sanitize(message.text)}`;
}

function formatInboxLine(message) {
  const when = message.date || message.receivedAt || "";
  const from = message.from ? ` ${message.from}` : "";
  return `[${when}] ${message.chatId}${from}: ${sanitize(message.text)}`;
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
  telegramSendPhoto,
  telegramSendFile,
  telegramSendDocument,
  telegramWaitReply,
  telegramAsk,
  telegramInboxRead,
  telegramMonitorStatus,
  telegramApprovalRequest,
  startTelegramMonitor,
  telegramApi,
  parseApprovalDecision
};
