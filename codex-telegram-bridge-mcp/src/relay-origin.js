"use strict";

const { readTelegramState } = require("./state.js");
const { relayPendingReplyTtlMs } = require("./config.js");
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

function selectTelegramOriginReply(replies, input, options = {}) {
  const active = (Array.isArray(replies) ? replies : []).filter((reply) => isActiveRelayReply(reply, options));
  const turnId = hookTurnId(input);
  const sessionId = hookSessionId(input);

  return latest(active.filter((reply) => turnId && reply.turnId === turnId)) ||
    latest(active.filter((reply) => sessionId && reply.threadId === sessionId)) ||
    null;
}

function isActiveRelayReply(reply, options = {}) {
  if (!reply || !reply.id || !reply.chatId) return false;
  if (isRelayReplyExpired(reply, options)) return false;
  const status = String(reply.status || "pending");
  if (status === "pending") return true;
  if (status !== "sending") return false;
  const startedAt = Date.parse(reply.replyStartedAt || "");
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return !Number.isFinite(startedAt) || now - startedAt > SENDING_STALE_MS;
}

function isRelayReplyExpired(reply, options = {}) {
  const deliveredAt = Date.parse(reply && reply.deliveredAt || "");
  if (!Number.isFinite(deliveredAt)) return true;
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : relayPendingReplyTtlMs();
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return now - deliveredAt > ttlMs;
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
  isActiveRelayReply,
  isRelayReplyExpired,
  isTelegramOriginHookInput,
  selectTelegramOriginReply
};
