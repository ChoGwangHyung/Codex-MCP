"use strict";

const {
  readTelegramState,
  writeTelegramState,
  withTelegramStateLock
} = require("./state.js");
const { telegramSend } = require("./telegram.js");
const {
  findTelegramOriginReply,
  hookCwd,
  hookSessionId,
  hookTurnId,
  selectTelegramOriginReply
} = require("./relay-origin.js");
const { sanitize } = require("./util.js");

const MAX_TELEGRAM_TEXT_CHARS = 3900;

async function handleStopHook(input, options = {}) {
  if (!isStopEvent(input)) {
    return { sent: false, reason: "not stop event" };
  }

  const claim = await claimPendingReply(input);
  if (!claim) {
    return { sent: false, reason: "no pending telegram relay reply" };
  }

  const sendText = typeof options.sendText === "function" ? options.sendText : sendTelegramText;
  try {
    const text = stopReplyText(input);
    await sendText({ chatId: claim.chatId, text });
    await markPendingReply(claim.id, "sent", {
      replySentAt: new Date().toISOString(),
      replyError: ""
    });
    return { sent: true, chatId: claim.chatId, pendingReplyId: claim.id };
  } catch (error) {
    const message = sanitize(error.message || "Telegram stop hook failed");
    await markPendingReply(claim.id, "failed", {
      replyFailedAt: new Date().toISOString(),
      replyError: message
    });
    return { sent: false, reason: message, pendingReplyId: claim.id };
  }
}

async function claimPendingReply(input) {
  return withTelegramStateLock(async () => {
    const state = readTelegramState();
    const candidate = findTelegramOriginReply(input, { state });
    if (!candidate) return null;

    const now = new Date().toISOString();
    candidate.status = "sending";
    candidate.replyStartedAt = now;
    candidate.hookSessionId = hookSessionId(input);
    candidate.hookTurnId = hookTurnId(input);
    candidate.hookCwd = hookCwd(input);
    updateInboxReplyState(state, candidate, {
      relayReplyStatus: "sending",
      relayReplyStartedAt: now,
      relayReplyError: ""
    });
    writeTelegramState(state);
    return { ...candidate };
  });
}

async function markPendingReply(id, status, fields) {
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const relay = state.relay && typeof state.relay === "object" ? state.relay : {};
    const replies = Array.isArray(relay.pendingReplies) ? relay.pendingReplies : [];
    const reply = replies.find((item) => item && item.id === id);
    if (!reply) return;
    Object.assign(reply, fields || {}, { status });
    updateInboxReplyState(state, reply, {
      relayReplyStatus: status,
      relayReplySentAt: status === "sent" ? fields.replySentAt : "",
      relayReplyFailedAt: status === "failed" ? fields.replyFailedAt : "",
      relayReplyError: fields.replyError || ""
    });
    writeTelegramState(state);
  });
}

function updateInboxReplyState(state, reply, fields) {
  const inbox = Array.isArray(state.inbox) ? state.inbox : [];
  const message = inbox.find((item) => {
    return item && (item.id === reply.inboxMessageId || item.id === reply.id);
  });
  if (!message) return;
  Object.assign(message, fields);
}

async function sendTelegramText({ chatId, text }) {
  for (const chunk of telegramTextChunks(text)) {
    await telegramSend({
      chatId,
      text: chunk,
      disableWebPagePreview: true
    });
  }
}

function telegramTextChunks(text) {
  const safe = sanitize(text).trim() || "작업이 완료되었습니다.";
  const chunks = [];
  let remaining = safe;
  while (remaining.length > MAX_TELEGRAM_TEXT_CHARS) {
    let index = remaining.lastIndexOf("\n", MAX_TELEGRAM_TEXT_CHARS);
    if (index < Math.floor(MAX_TELEGRAM_TEXT_CHARS / 2)) index = MAX_TELEGRAM_TEXT_CHARS;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function stopReplyText(input) {
  return String(input && (
    input.last_assistant_message ||
    input.lastAssistantMessage ||
    input.assistant_message ||
    input.assistantMessage ||
    ""
  ) || "");
}

function isStopEvent(input) {
  const name = String(input && (input.hook_event_name || input.hookEventName) || "").toLowerCase();
  return name === "stop";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function runCli() {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    await handleStopHook(input);
  } catch {
    // Stop hook failures must not affect the completed Codex turn.
  }
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
}

module.exports = {
  handleStopHook,
  selectPendingReply: selectTelegramOriginReply,
  telegramTextChunks,
  stopReplyText,
  runCli
};
