"use strict";

const { readTelegramState } = require("./state.js");
const { normalizePath } = require("./util.js");

const SENDING_STALE_MS = 5 * 60 * 1000;

function isTelegramOriginHookInput(input) {
  return Boolean(findTelegramOriginReply(input));
}

function findTelegramOriginReply(input, options = {}) {
  const state = options.state || readTelegramState();
  const relay = state.relay && typeof state.relay === "object" ? state.relay : {};
  const replies = Array.isArray(relay.pendingReplies) ? relay.pendingReplies : [];
  return selectTelegramOriginReply(replies, input);
}

function selectTelegramOriginReply(replies, input) {
  const active = (Array.isArray(replies) ? replies : []).filter(isActiveRelayReply);
  const turnId = hookTurnId(input);
  const sessionId = hookSessionId(input);

  return latest(active.filter((reply) => turnId && reply.turnId === turnId)) ||
    latest(active.filter((reply) => sessionId && reply.threadId === sessionId)) ||
    null;
}

function isActiveRelayReply(reply) {
  if (!reply || !reply.id || !reply.chatId) return false;
  const status = String(reply.status || "pending");
  if (status === "pending") return true;
  if (status !== "sending") return false;
  const startedAt = Date.parse(reply.replyStartedAt || "");
  return !Number.isFinite(startedAt) || Date.now() - startedAt > SENDING_STALE_MS;
}

function latest(replies) {
  if (!replies.length) return null;
  return [...replies].sort((left, right) => timestamp(right) - timestamp(left))[0];
}

function timestamp(reply) {
  const parsed = Date.parse(reply && (reply.deliveredAt || reply.replyStartedAt) || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function hookSessionId(input) {
  return String(input && (input.session_id || input.sessionId || input.thread_id || input.threadId) || "");
}

function hookTurnId(input) {
  return String(input && (input.turn_id || input.turnId) || "");
}

function hookCwd(input) {
  return normalizePath(input && input.cwd || process.cwd());
}

module.exports = {
  findTelegramOriginReply,
  hookCwd,
  hookSessionId,
  hookTurnId,
  isTelegramOriginHookInput,
  selectTelegramOriginReply
};
