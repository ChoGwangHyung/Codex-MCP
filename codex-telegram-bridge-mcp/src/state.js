"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { telegramStatePath } = require("./config.js");

function readTelegramState() {
  try {
    return normalizeTelegramState(JSON.parse(fs.readFileSync(telegramStatePath(), "utf8")));
  } catch {
    return normalizeTelegramState({});
  }
}

function writeTelegramState(state) {
  const file = telegramStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalizeTelegramState(state), null, 2));
}

function normalizeTelegramState(value) {
  const state = value && typeof value === "object" ? value : {};
  const inbox = Array.isArray(state.inbox) ? state.inbox.filter(isInboxMessage) : [];
  const relay = state.relay && typeof state.relay === "object" ? state.relay : {};
  const permissionAlwaysApprovals = state.permissionAlwaysApprovals && typeof state.permissionAlwaysApprovals === "object"
    ? state.permissionAlwaysApprovals
    : {};
  const permissionPendingApprovals = state.permissionPendingApprovals && typeof state.permissionPendingApprovals === "object"
    ? state.permissionPendingApprovals
    : {};
  return {
    ...state,
    updateOffset: Number.isFinite(Number(state.updateOffset)) ? Number(state.updateOffset) : 0,
    inbox,
    relay,
    permissionAlwaysApprovals,
    permissionPendingApprovals
  };
}

function isInboxMessage(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.chatId === "string" &&
    typeof value.text === "string"
  );
}

module.exports = {
  readTelegramState,
  writeTelegramState,
  normalizeTelegramState
};
