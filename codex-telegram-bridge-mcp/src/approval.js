"use strict";

const crypto = require("node:crypto");
const { APPROVE_TOKENS, DENY_TOKENS } = require("./constants.js");
const { sanitize } = require("./util.js");

const TELEGRAM_MESSAGE_LIMIT = 4096;

function createApprovalCode() {
  return crypto.randomBytes(3).toString("hex");
}

function parseApprovalDecision(text, code) {
  const normalized = String(text || "").trim().toLowerCase();
  const normalizedCode = String(code || "").trim().toLowerCase();
  const withoutCode = normalizedCode
    ? normalized.replace(normalizedCode, "").trim()
    : normalized;
  const firstToken = withoutCode.split(/\s+/).filter(Boolean)[0] || withoutCode;
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
    keyboard: [[`approve ${code}`, `deny ${code}`]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function approvalRequestText({ title, message, code }) {
  const body = [
    "Approval request / 승인 요청",
    "",
    sanitize(title),
    "",
    sanitize(message),
    "",
    `Code / 코드: ${code}`,
    `Approve: choose or type 'approve ${code}' or '승인 ${code}'.`,
    `Deny: choose or type 'deny ${code}' or '거부 ${code}'.`
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
  parseApprovalDecision,
  approvalReplyMarkup,
  approvalRequestText,
  truncateTelegramText
};
