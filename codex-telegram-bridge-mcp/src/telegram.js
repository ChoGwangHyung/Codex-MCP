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
  downloadMaxBytes,
  orphanCallbackGraceMs,
  orphanCallbackMaxAgeMs,
  telegramEnabled,
  allowedChatIds,
  assertTelegram,
  bridgeEnabled,
  telegramDownloadDir,
  relayTargetCwd
} = require("./config.js");
const {
  readTelegramState,
  writeTelegramState,
  withTelegramStateLock
} = require("./state.js");
const {
  brokerStatus,
  claimBrokerUpdate,
  claimOrphanCallbacks,
  completeBrokerUpdate,
  consumeBrokerUpdates,
  createBrokerSubscription,
  monitorConsumer,
  pollBrokerUpdates,
  releaseBrokerUpdate,
  removeBrokerSubscription,
  retireBrokerSubscription
} = require("./broker.js");
const { normalizeTimeout, normalizeInteger, delay, sanitize } = require("./util.js");
const {
  approvalRequestText,
  parseApprovalDecision
} = require("./approval.js");
const {
  choiceExpiredText,
  choiceReplyMarkup,
  choiceSelectionText,
  choiceSubscriberId,
  createChoiceRequestId,
  findChoiceByText,
  normalizeChoices,
  parseChoiceCallbackData,
  selectedChoiceResult,
  timeoutChoiceResult
} = require("./choices.js");
const {
  claimChoicePrompt,
  markChoicePrompt,
  releaseChoicePrompt
} = require("./choice-state.js");

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
    await clearInboxForChat(chatId);
  }

  const existing = await takeFirstInboxMessage(chatId, true);
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
      const result = await pollSharedTelegramUpdates(0);
      if (!Array.isArray(result.updates) || result.updates.length < 100) break;
    }
    await createBrokerSubscription(monitorSubscriberId(), { startAtEnd: true, reset: true });
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
  await clearInboxForChat(chatId);

  if (choices.length === 0) {
    await telegramSend({ ...args, chatId, text });
    return telegramWaitReply({ ...args, chatId, timeoutMs, ignoreExisting: false });
  }

  const requestId = createChoiceRequestId();
  const subscriberId = choiceSubscriberId(requestId);
  await createBrokerSubscription(subscriberId, {
    startAtEnd: true,
    reset: true,
    routeConsumerId: currentMonitorConsumer().id,
    chatIds: [chatId],
    interceptMessages: true,
    expiresInMs: timeoutMs
  });
  try {
    const sent = await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: Boolean(args.disableWebPagePreview),
      reply_markup: choiceReplyMarkup(requestId, choices)
    });
    const messageId = sent && sent.message_id;
    const result = await waitForChoiceResponse({
      chatId,
      messageId,
      question: text,
      choices,
      requestId,
      subscriberId,
      timeoutMs
    });
    if (result.timeout) {
      await markChoicePrompt(chatId, messageId, "expired");
    } else {
      await markChoicePrompt(chatId, messageId, "settled");
    }
    await retireBrokerSubscription(subscriberId, {
      retainForMs: orphanCallbackMaxAgeMs()
    });
    if (result.timeout) {
      await expireChoiceMessage(chatId, messageId, text);
    }
    return JSON.stringify(result, null, 2);
  } catch (error) {
    await removeBrokerSubscription(subscriberId);
    throw error;
  }
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
  const messages = await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const selected = state.inbox
      .filter((message) => (!chatId || message.chatId === chatId) && allowed.has(message.chatId))
      .slice(0, limit);
    if (consume && selected.length > 0) {
      const consumed = new Set(selected.map((message) => message.id));
      state.inbox = state.inbox.filter((message) => !consumed.has(message.id));
      writeTelegramState(state);
    }
    return selected;
  });

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
  const consumer = currentMonitorConsumer();
  const shared = await brokerStatus(consumer.id);
  const allowed = allowedChatIds();
  const perChat = new Map();
  for (const message of state.inbox) {
    perChat.set(message.chatId, (perChat.get(message.chatId) || 0) + 1);
  }

  return [
    `telegram_monitor: ${monitorStarted ? "started" : "stopped"}`,
    `running: ${monitorRunning ? "yes" : "no"}`,
    `configured: ${telegramEnabled() ? "yes" : "no"}`,
    `update_offset: ${shared.updateOffset || state.updateOffset || 0}`,
    `broker_records: ${shared.records}`,
    `broker_consumer: ${consumer.label} (${consumer.shortId})`,
    `broker_sessions: ${shared.consumers.filter((item) => item.active).length}`,
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
      await delay(150);
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
  await createBrokerSubscription(monitorSubscriberId(), { startAtEnd: false });
  const polled = await pollSharedTelegramUpdates(timeoutSeconds);
  await sendBrokerControlActions(polled.controlActions);
  const updates = await consumeBrokerUpdates(monitorSubscriberId(), {
    mode: "monitor",
    consumerId: currentMonitorConsumer().id,
    startAtEnd: false
  });
  const allowedMessages = await buildAllowedMessages(updates);
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    state.updateOffset = Math.max(Number(state.updateOffset || 0), Number(polled.updateOffset || 0));
    appendAllowedMessages(state, allowedMessages);
    state.lastPollAt = new Date().toISOString();
    monitorLastPollAt = state.lastPollAt;
    if (monitorLastErrorAt) state.lastErrorAt = monitorLastErrorAt;
    writeTelegramState(state);
  });
  await handleOrphanCallbacks();
  await notifyChoiceWaiters();
  await notifyInboxWaiters();
}

async function handleOrphanCallbacks() {
  const consumer = currentMonitorConsumer();
  while (true) {
    const records = await claimOrphanCallbacks(consumer.id, {
      claimId: `orphan:${consumer.id}`,
      graceMs: orphanCallbackGraceMs(),
      limit: 1
    });
    if (records.length === 0) return;

    const record = records[0];
    try {
      const message = await settleOrphanCallback(record);
      if (message) {
        await withTelegramStateLock(async () => {
          const state = readTelegramState();
          appendAllowedMessages(state, [message]);
          writeTelegramState(state);
        });
        await markChoicePrompt(message.chatId, message.messageId, "settled");
      }
      const completed = await completeBrokerUpdate(
        record.update && record.update.update_id,
        record.claimId
      );
      if (!completed) throw new Error("Failed to complete an orphan Telegram callback claim.");
    } catch (error) {
      const callbackMessage = record.update && record.update.callback_query &&
        record.update.callback_query.message;
      await Promise.allSettled([
        releaseChoicePrompt(
          callbackMessage && callbackMessage.chat && callbackMessage.chat.id,
          callbackMessage && callbackMessage.message_id,
          record.claimId
        ),
        releaseBrokerUpdate(
          record.update && record.update.update_id,
          record.claimId
        )
      ]);
      throw error;
    }
  }
}

async function settleOrphanCallback(record) {
  const update = record && record.update;
  const callback = update && update.callback_query;
  const message = callback && callback.message;
  const chatId = message && message.chat && String(message.chat.id);
  if (!chatId || !allowedChatIds().has(chatId)) return null;

  const messageId = Number(message.message_id || 0);
  const label = callbackButtonLabel(callback);
  if (record.deliverToSession === false) {
    await answerChoiceCallback(callback.id, "원래 세션이 종료되어 이 요청을 만료 처리했습니다.");
    if (!(await clearChoiceKeyboard(chatId, messageId))) {
      throw new Error("Failed to clear an orphan Telegram callback keyboard.");
    }
    return null;
  }
  // Old prompts and long-queued presses are closed out without replaying them
  // into a session that may already have moved on.
  const choice = parseChoiceCallbackData(callback.data);
  if (!choice) {
    await answerChoiceCallback(callback.id, "이 요청은 이미 만료되었습니다.");
    if (!(await clearChoiceKeyboard(chatId, messageId))) {
      throw new Error("Failed to clear an expired Telegram approval keyboard.");
    }
    return null;
  }
  const stale = isStaleOrphanCallback(callback, record.receivedAt);
  if (stale || !label) {
    await answerChoiceCallback(callback.id, "이 요청은 이미 만료되었습니다.");
    if (!(await expireChoiceMessage(chatId, messageId, message.text))) {
      throw new Error("Failed to expire an orphan Telegram choice message.");
    }
    return null;
  }

  if (!(await claimChoicePrompt(chatId, messageId, record.claimId))) {
    await answerChoiceCallback(callback.id, "이 선택은 이미 처리되었습니다.");
    if (!(await clearChoiceKeyboard(chatId, messageId))) {
      throw new Error("Failed to clear a duplicate Telegram choice keyboard.");
    }
    return null;
  }

  await answerChoiceCallback(callback.id, `선택 전달됨: ${label}`);
  if (!(await updateChoiceMessage(callback, message.text, label))) {
    throw new Error("Failed to settle an orphan Telegram choice message.");
  }
  return orphanCallbackInboxMessage(update, callback, label, choice.requestId);
}

function isStaleOrphanCallback(callback, receivedAt) {
  const receivedTimestamp = Date.parse(receivedAt || "");
  const messageDate = Number(callback && callback.message && callback.message.date);
  const promptTimestamp = Number.isFinite(messageDate) && messageDate > 0
    ? messageDate * 1000
    : NaN;
  const maxAgeMs = orphanCallbackMaxAgeMs();
  return [receivedTimestamp, promptTimestamp].some((timestamp) => {
    return Number.isFinite(timestamp) && Date.now() - timestamp > maxAgeMs;
  });
}

function callbackButtonLabel(callback) {
  const message = callback && callback.message;
  const rows = message && message.reply_markup && message.reply_markup.inline_keyboard;
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const button of Array.isArray(row) ? row : []) {
      if (button && button.callback_data === callback.data) return sanitize(button.text);
    }
  }
  return "";
}

function orphanCallbackInboxMessage(update, callback, label, requestId) {
  const message = callback.message || {};
  const now = new Date().toISOString();
  return {
    id: `${Number(update.update_id || 0)}:${Number(message.message_id || 0)}`,
    updateId: Number(update.update_id || 0),
    messageId: Number(message.message_id || 0),
    chatId: String(message.chat.id),
    text: label,
    date: now,
    receivedAt: now,
    userId: callback.from && callback.from.id !== undefined ? String(callback.from.id) : "",
    from: displayName(callback),
    attachments: [],
    source: "button",
    choiceRequestId: requestId
  };
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

async function pollSharedTelegramUpdates(timeoutSeconds) {
  const state = readTelegramState();
  return pollBrokerUpdates(telegramApi, timeoutSeconds, {
    consumer: currentMonitorConsumer(),
    allowedChatIds: allowedChatIds(),
    seedOffset: Number(state.updateOffset || 0)
  });
}

async function sendBrokerControlActions(actions) {
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || !allowedChatIds().has(String(action.chatId))) continue;
    await telegramApi("sendMessage", {
      chat_id: action.chatId,
      text: action.text,
      disable_web_page_preview: true
    }).catch(() => {});
  }
}

function currentMonitorConsumer() {
  return monitorConsumer(relayTargetCwd());
}

function monitorSubscriberId() {
  return `monitor:${currentMonitorConsumer().id}`;
}

async function buildAllowedMessages(updates) {
  const allowed = allowedChatIds();
  const messages = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update.message;
    const chatId = message && message.chat && String(message.chat.id);
    if (!chatId || !allowed.has(chatId)) continue;
    const inboxMessage = await inboxMessageFromTelegramUpdate(update, message);
    if (inboxMessage) messages.push(inboxMessage);
  }
  return messages;
}

async function inboxMessageFromTelegramUpdate(update, message) {
  const chatId = message && message.chat && String(message.chat.id);
  const text = message && typeof message.text === "string" ? sanitize(message.text) : "";
  const caption = message && typeof message.caption === "string" ? sanitize(message.caption) : "";
  const attachment = await incomingAttachmentFromMessage(update, message);
  const body = formatIncomingMessageText(text || caption, attachment);
  if (!chatId || !body) return null;
  return {
    id: `${update.update_id}:${message.message_id || 0}`,
    updateId: Number(update.update_id || 0),
    messageId: Number(message.message_id || 0),
    chatId,
    text: body,
    date: message.date ? new Date(Number(message.date) * 1000).toISOString() : "",
    receivedAt: new Date().toISOString(),
    userId: message.from && message.from.id !== undefined ? String(message.from.id) : "",
    from: displayName(message),
    attachments: attachment ? [attachment] : []
  };
}

function formatIncomingMessageText(text, attachment) {
  const lines = [];
  const body = sanitize(text || "");
  if (body) lines.push(body);
  if (attachment) {
    if (lines.length > 0) lines.push("");
    lines.push(`Attachment: ${attachment.type}`);
    if (attachment.localPath) lines.push(`Local file: ${attachment.localPath}`);
    if (!attachment.localPath && attachment.fileName) lines.push(`File name: ${attachment.fileName}`);
    if (!attachment.localPath && Number.isFinite(Number(attachment.fileSize))) {
      lines.push(`Size: ${Number(attachment.fileSize)} bytes`);
    }
    if (attachment.downloadError) lines.push(`Download error: ${attachment.downloadError}`);
  }
  return lines.join("\n").trim();
}

async function incomingAttachmentFromMessage(update, message) {
  const media = incomingMediaFromMessage(message);
  if (!media) return null;
  const base = {
    type: media.type,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId || "",
    fileName: media.fileName || "",
    mimeType: media.mimeType || "",
    fileSize: Number(media.fileSize || 0)
  };

  try {
    return {
      ...base,
      ...(await downloadIncomingTelegramFile(media, update, message))
    };
  } catch (error) {
    return {
      ...base,
      downloadError: sanitize(error.message || "download failed")
    };
  }
}

function incomingMediaFromMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((left, right) => Number(right.file_size || 0) - Number(left.file_size || 0))[0];
    return {
      type: "photo",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileSize: photo.file_size,
      mimeType: "image/jpeg"
    };
  }
  if (message.document) return documentLikeMedia("document", message.document);
  if (message.animation) return documentLikeMedia("animation", message.animation);
  if (message.video) return documentLikeMedia("video", message.video);
  if (message.audio) return documentLikeMedia("audio", message.audio);
  if (message.voice) return documentLikeMedia("voice", message.voice);
  return null;
}

function documentLikeMedia(type, value) {
  return {
    type,
    fileId: value.file_id,
    fileUniqueId: value.file_unique_id,
    fileName: value.file_name || "",
    mimeType: value.mime_type || "",
    fileSize: value.file_size
  };
}

async function downloadIncomingTelegramFile(media, update, message) {
  if (!media.fileId) throw new Error("Telegram media has no file_id");
  const file = await telegramApi("getFile", { file_id: media.fileId });
  const filePath = String(file && file.file_path || "");
  if (!filePath) throw new Error("Telegram getFile did not return file_path");

  const maxBytes = downloadMaxBytes();
  const expectedSize = Number(file.file_size || media.fileSize || 0);
  if (expectedSize > maxBytes) {
    throw new Error(`Telegram file is too large to download: ${expectedSize} bytes, max ${maxBytes} bytes`);
  }

  const fileName = incomingDownloadFileName(media, filePath, update, message);
  const localPath = path.join(telegramDownloadDir(), fileName);
  const actualSize = await downloadTelegramFileContent(filePath, localPath, maxBytes);
  return {
    localPath,
    fileName,
    fileSize: actualSize,
    telegramFilePath: filePath
  };
}

function incomingDownloadFileName(media, filePath, update, message) {
  const fallback = `${media.type || "file"}${path.extname(path.posix.basename(filePath)) || ".bin"}`;
  const original = media.fileName || path.posix.basename(filePath) || fallback;
  const prefix = [
    Number(update && update.update_id || 0),
    Number(message && message.message_id || 0),
    media.type || "file"
  ].join("-");
  return safeFileName(`${prefix}-${original}`);
}

async function downloadTelegramFileContent(filePath, localPath, maxBytes) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const encodedPath = String(filePath).split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${encodedPath}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${sanitize(response.statusText || response.status || "unknown error")}`);
  }

  const contentLength = Number(response.headers && response.headers.get && response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`Telegram file is too large to download: ${contentLength} bytes, max ${maxBytes} bytes`);
  }

  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  if (!response.body) throw new Error("Telegram file download returned no body");
  const tempPath = `${localPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.promises.open(tempPath, "w");
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new Error(`Telegram file is too large to download: more than ${maxBytes} bytes`);
      }
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
  await handle.close();
  await fs.promises.unlink(localPath).catch((error) => {
    if (error && error.code !== "ENOENT") throw error;
  });
  await fs.promises.rename(tempPath, localPath);
  return total;
}

function appendAllowedMessages(state, messages) {
  const seen = new Set(state.inbox.map((message) => message.id));
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    state.inbox.push(message);
  }
  if (state.inbox.length > inboxMaxMessages()) {
    state.inbox = state.inbox.slice(-inboxMaxMessages());
  }
}

async function takeFirstInboxMessage(chatId, consume) {
  return withTelegramStateLock(async () => {
    const state = readTelegramState();
    const index = state.inbox.findIndex((message) => isInboxReplyMessage(message, chatId));
    if (index < 0) return null;
    const [message] = consume ? state.inbox.splice(index, 1) : [state.inbox[index]];
    if (consume) writeTelegramState(state);
    return message;
  });
}

function isInboxReplyMessage(message, chatId) {
  return Boolean(message) &&
    message.chatId === String(chatId) &&
    message.source !== "button";
}

async function clearInboxForChat(chatId) {
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const before = state.inbox.length;
    state.inbox = state.inbox.filter((message) => {
      return message.chatId !== String(chatId) || message.source === "button";
    });
    if (state.inbox.length !== before) writeTelegramState(state);
  });
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

function waitForChoiceResponse({ chatId, messageId, question, choices, requestId, subscriberId, timeoutMs }) {
  return new Promise((resolve) => {
    const waiter = {
      chatId: String(chatId),
      messageId: Number(messageId || 0),
      question,
      choices,
      requestId,
      subscriberId,
      resolve,
      done: false,
      settling: false,
      timer: null,
      deadlineAt: Date.now() + timeoutMs
    };
    choiceWaiters.add(waiter);
    armChoiceTimeout(waiter);
    void notifyChoiceWaiters();
    void pollChoiceUntilSettled(waiter);
  });
}

async function pollChoiceUntilSettled(waiter) {
  while (!waiter.done) {
    try {
      const available = await consumeBrokerUpdates(waiter.subscriberId, { startAtEnd: true });
      await processChoiceCallbacks(available, waiter);
      await processChoiceTextUpdates(available, waiter);
      if (waiter.done) continue;
      const polled = await withPollLock(() => pollSharedTelegramUpdates(2));
      await sendBrokerControlActions(polled.controlActions);
      if (waiter.done) continue;
      const updates = await consumeBrokerUpdates(waiter.subscriberId, { startAtEnd: true });
      await processChoiceCallbacks(updates, waiter);
      await processChoiceTextUpdates(updates, waiter);
    } catch {
      await delay(1000);
    }
    if (!waiter.done) await delay(100);
  }
}

async function waitForInboxMessage(chatId, timeoutMs) {
  const existing = await takeFirstInboxMessage(chatId, true);
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
    void notifyInboxWaiters();
  });
}

async function notifyInboxWaiters() {
  for (const waiter of Array.from(inboxWaiters)) {
    const message = await takeFirstInboxMessage(waiter.chatId, true);
    if (!message) continue;
    clearTimeout(waiter.timer);
    inboxWaiters.delete(waiter);
    waiter.resolve(message);
  }
}

async function notifyChoiceWaiters() {
  for (const waiter of Array.from(choiceWaiters)) {
    if (!reserveChoiceWaiter(waiter)) continue;
    try {
      const message = await takeMatchingChoiceMessage(waiter);
      if (!message) {
        releaseChoiceWaiter(waiter);
        continue;
      }
      const choice = findChoiceByText(waiter.choices, message.text);
      const claimed = await claimBrokerUpdate(
        message.updateId,
        waiter.subscriberId || `choice:${waiter.requestId}`
      );
      if (!claimed) {
        releaseChoiceWaiter(waiter);
        continue;
      }
      settleChoiceWaiter(waiter, selectedChoiceResult({
        choice,
        chatId: message.chatId,
        messageId: waiter.messageId || message.messageId,
        userId: message.userId,
        timestamp: message.receivedAt || message.date,
        source: "text",
        requestId: waiter.requestId
      }));
    } catch (error) {
      releaseChoiceWaiter(waiter);
      throw error;
    }
  }
}

async function takeMatchingChoiceMessage(waiter) {
  return withTelegramStateLock(async () => {
    const state = readTelegramState();
    const index = state.inbox.findIndex((message) => {
      return isChoiceTextMessageForWaiter(message, waiter);
    });
    if (index < 0) return null;
    const [message] = state.inbox.splice(index, 1);
    writeTelegramState(state);
    return message;
  });
}

function isChoiceTextMessageForWaiter(message, waiter) {
  if (!message || message.source === "button" || message.choiceRequestId) return false;
  return message.chatId === waiter.chatId &&
    Boolean(findChoiceByText(waiter.choices, message.text));
}

async function processChoiceCallbacks(updates, targetWaiter) {
  for (const update of Array.isArray(updates) ? updates : []) {
    const callback = update.callback_query;
    if (!callback) continue;
    const parsed = parseChoiceCallbackData(callback.data);
    if (!parsed || parsed.requestId !== targetWaiter.requestId) continue;

    const waiter = findChoiceWaiter(parsed.requestId, callback);
    // Leave settled or unknown selections unclaimed so the monitor's orphan
    // callback sweep answers them and relays the choice into the session.
    if (!waiter || waiter.done || waiter.settling) continue;

    const choice = waiter.choices[parsed.index];
    if (!choice) {
      await answerChoiceCallback(callback.id, "알 수 없는 선택입니다.");
      continue;
    }

    const chatId = callback.message && callback.message.chat && String(callback.message.chat.id);
    if (!allowedChatIds().has(chatId)) continue;
    if (!reserveChoiceWaiter(waiter)) continue;
    let claimed;
    try {
      claimed = await claimBrokerUpdate(update.update_id, waiter.subscriberId);
    } catch (error) {
      releaseChoiceWaiter(waiter);
      throw error;
    }
    if (!claimed) {
      releaseChoiceWaiter(waiter);
      continue;
    }
    const result = selectedChoiceResult({
      choice,
      chatId: callback.message && callback.message.chat && callback.message.chat.id,
      messageId: callback.message && callback.message.message_id,
      userId: callback.from && callback.from.id,
      timestamp: new Date().toISOString(),
      source: "button",
      requestId: waiter.requestId
    });
    let messageUpdated = false;
    try {
      await markChoicePrompt(chatId, callback.message && callback.message.message_id, "settled");
      await answerChoiceCallback(callback.id, `선택됨: ${choice.label}`);
      messageUpdated = await updateChoiceMessage(callback, waiter.question, choice.label);
    } finally {
      if (!messageUpdated) {
        await releaseBrokerUpdate(update.update_id, waiter.subscriberId).catch(() => false);
      }
      settleChoiceWaiter(waiter, result);
    }
  }
}

async function processChoiceTextUpdates(updates, waiter) {
  if (waiter.done) return;
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update && update.message;
    const chatId = message && message.chat && String(message.chat.id);
    const text = message && (message.text || message.caption);
    if (!chatId || chatId !== waiter.chatId || !allowedChatIds().has(chatId)) continue;
    const choice = findChoiceByText(waiter.choices, sanitize(text || ""));
    if (!choice) continue;
    if (!reserveChoiceWaiter(waiter)) continue;
    let claimed;
    try {
      claimed = await claimBrokerUpdate(update.update_id, waiter.subscriberId);
    } catch (error) {
      releaseChoiceWaiter(waiter);
      throw error;
    }
    if (!claimed) {
      releaseChoiceWaiter(waiter);
      continue;
    }
    const result = selectedChoiceResult({
      choice,
      chatId,
      messageId: waiter.messageId || message.message_id,
      userId: message.from && message.from.id,
      timestamp: message.date ? new Date(Number(message.date) * 1000).toISOString() : new Date().toISOString(),
      source: "text",
      requestId: waiter.requestId
    });
    try {
      await removeInboxUpdate(update.update_id);
    } finally {
      settleChoiceWaiter(waiter, result);
    }
    return;
  }
}

async function removeInboxUpdate(updateId) {
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const next = state.inbox.filter((message) => Number(message.updateId) !== Number(updateId));
    if (next.length === state.inbox.length) return;
    state.inbox = next;
    writeTelegramState(state);
  });
}

function findChoiceWaiter(requestId, callback) {
  const chatId = callback && callback.message && callback.message.chat && String(callback.message.chat.id);
  const messageId = callback && callback.message && Number(callback.message.message_id || 0);
  return Array.from(choiceWaiters).find((waiter) => {
    return waiter.requestId === requestId &&
      !waiter.settling &&
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
  return replaceChoiceMessageText(chatId, messageId, choiceSelectionText(question, label));
}

async function expireChoiceMessage(chatId, messageId, question) {
  return replaceChoiceMessageText(chatId, messageId, choiceExpiredText(question));
}

async function replaceChoiceMessageText(chatId, messageId, text) {
  if (!chatId || !messageId) return false;
  const updated = text
    ? await telegramApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [] }
      }).then(() => true).catch(telegramEditAlreadyApplied)
    : false;
  if (updated) return true;
  return clearChoiceKeyboard(chatId, messageId);
}

async function clearChoiceKeyboard(chatId, messageId) {
  if (!chatId || !messageId) return false;
  const cleared = await telegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  }).then(() => true).catch(telegramEditAlreadyApplied);
  if (cleared) return true;
  return telegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId
  }).then(() => true).catch(telegramEditAlreadyApplied);
}

function telegramEditAlreadyApplied(error) {
  return /message is not modified/i.test(String(error && error.message || ""));
}

function armChoiceTimeout(waiter) {
  if (waiter.done || waiter.settling) return;
  clearTimeout(waiter.timer);
  const remainingMs = Math.max(0, Number(waiter.deadlineAt || 0) - Date.now());
  waiter.timer = setTimeout(() => {
    if (!reserveChoiceWaiter(waiter)) return;
    settleChoiceWaiter(waiter, timeoutChoiceResult({
      chatId: waiter.chatId,
      messageId: waiter.messageId,
      requestId: waiter.requestId
    }));
  }, remainingMs);
}

function reserveChoiceWaiter(waiter) {
  if (!waiter || waiter.done || waiter.settling) return false;
  waiter.settling = true;
  clearTimeout(waiter.timer);
  waiter.timer = null;
  return true;
}

function releaseChoiceWaiter(waiter) {
  if (!waiter || waiter.done || !waiter.settling) return;
  waiter.settling = false;
  armChoiceTimeout(waiter);
}

function settleChoiceWaiter(waiter, result) {
  if (waiter.done) return;
  waiter.done = true;
  waiter.settling = true;
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
  parseApprovalDecision,
  _test: {
    buildAllowedMessages,
    callbackButtonLabel,
    downloadTelegramFileContent,
    formatIncomingMessageText,
    handleOrphanCallbacks,
    incomingMediaFromMessage,
    isChoiceTextMessageForWaiter,
    isInboxReplyMessage,
    pollAndProcessTelegramUpdates
  }
};
