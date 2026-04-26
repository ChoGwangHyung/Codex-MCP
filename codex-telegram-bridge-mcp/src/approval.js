"use strict";

const crypto = require("node:crypto");
const { APPROVE_TOKENS, DENY_TOKENS } = require("./constants.js");
const { sanitize } = require("./util.js");

const TELEGRAM_MESSAGE_LIMIT = 4096;
const APPROVAL_CALLBACK_PREFIX = "ctba";
const ALWAYS_APPROVE_TOKENS = new Set(["always approve", "always allow", "always", "항상 승인", "항상 허용", "항상승인", "항상허용"]);

function createApprovalCode() {
  return crypto.randomBytes(3).toString("hex");
}

function parseApprovalDecision(text, code) {
  const normalized = String(text || "").trim().toLowerCase();
  const normalizedCode = String(code || "").trim().toLowerCase();
  if (!normalized) return "";
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (normalizedCode && tokens.length > 1 && !tokens.includes(normalizedCode)) {
    return "";
  }
  const withoutCode = normalizedCode
    ? normalized.replace(normalizedCode, "").trim()
    : normalized;
  const firstToken = withoutCode.split(/\s+/).filter(Boolean)[0] || withoutCode;
  if (ALWAYS_APPROVE_TOKENS.has(withoutCode) || ALWAYS_APPROVE_TOKENS.has(normalized)) {
    return "always_approved";
  }
  if (APPROVE_TOKENS.has(normalized) || APPROVE_TOKENS.has(withoutCode) || APPROVE_TOKENS.has(firstToken)) {
    return "approved";
  }
  if (DENY_TOKENS.has(normalized) || DENY_TOKENS.has(withoutCode) || DENY_TOKENS.has(firstToken)) {
    return "denied";
  }
  return "";
}

function approvalReplyMarkup(code) {
  return {
    inline_keyboard: [[
      { text: "승인", callback_data: formatApprovalCallbackData(code, "approve") },
      { text: "항상 승인", callback_data: formatApprovalCallbackData(code, "always") },
      { text: "거부", callback_data: formatApprovalCallbackData(code, "deny") }
    ]]
  };
}

function formatApprovalCallbackData(code, action) {
  return `${APPROVAL_CALLBACK_PREFIX}:${code}:${action}`;
}

function parseApprovalCallbackData(data, code) {
  const match = new RegExp(`^${APPROVAL_CALLBACK_PREFIX}:([a-f0-9]{6}):(approve|always|deny)$`).exec(String(data || ""));
  if (!match) return null;
  const callbackCode = match[1];
  if (code && callbackCode !== String(code).trim().toLowerCase()) return null;
  const decision = match[2] === "always"
    ? "always_approved"
    : match[2] === "approve" ? "approved" : "denied";
  return {
    code: callbackCode,
    decision
  };
}

function approvalRequestText({ title, message }) {
  const body = [
    "Approval request / 승인 요청",
    "",
    sanitize(title),
    "",
    sanitize(message)
  ].join("\n");
  return truncateTelegramText(body);
}

function truncateTelegramText(text) {
  const value = sanitize(text);
  if (value.length <= TELEGRAM_MESSAGE_LIMIT) return value;
  return `${value.slice(0, TELEGRAM_MESSAGE_LIMIT - 32)}\n...[truncated]`;
}

module.exports = {
  createApprovalCode,
  parseApprovalCallbackData,
  parseApprovalDecision,
  approvalReplyMarkup,
  approvalRequestText,
  truncateTelegramText
};
