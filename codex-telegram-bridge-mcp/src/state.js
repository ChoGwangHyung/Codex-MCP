"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { telegramStatePath } = require("./config.js");

const LOCK_STALE_MS = 120000;
const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 130000;

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
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalizeTelegramState(state), null, 2));
  fs.renameSync(temp, file);
}

async function withTelegramStateLock(work) {
  return withFileLock(telegramStateLockPath(), work);
}

async function withTelegramUpdateLock(work) {
  return withFileLock(telegramUpdateLockPath(), work);
}

async function withFileLock(lock, work) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const startedAt = Date.now();
  let handle = null;

  while (!handle) {
    try {
      handle = await fs.promises.open(lock, "wx");
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString()
        }));
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.promises.unlink(lock).catch(() => {});
        handle = null;
        throw error;
      }
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      await removeStaleLock(lock);
      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for Telegram lock: ${lock}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await work();
  } finally {
    await handle.close().catch(() => {});
    await fs.promises.unlink(lock).catch(() => {});
  }
}

function telegramStateLockPath() {
  return `${telegramStatePath()}.lock`;
}

function telegramUpdateLockPath() {
  const tokenHash = crypto
    .createHash("sha256")
    .update(String(process.env.TELEGRAM_BOT_TOKEN || "missing-token"))
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CodexTelegramBridge", "locks");
  return path.join(dir, `updates-${tokenHash}.lock`);
}

async function removeStaleLock(lock) {
  try {
    const stat = await fs.promises.stat(lock);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return;
    await fs.promises.unlink(lock);
  } catch {
    // A competing process may have released the lock.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTelegramState(value) {
  const state = value && typeof value === "object" ? value : {};
  const inbox = Array.isArray(state.inbox) ? state.inbox.filter(isInboxMessage) : [];
  const relay = normalizeRelayState(state.relay);
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

function normalizeRelayState(value) {
  const relay = value && typeof value === "object" ? value : {};
  return {
    ...relay,
    pendingReplies: Array.isArray(relay.pendingReplies)
      ? relay.pendingReplies.filter(isPendingReply)
      : []
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

function isPendingReply(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.chatId === "string"
  );
}

module.exports = {
  readTelegramState,
  writeTelegramState,
  normalizeTelegramState,
  withTelegramStateLock,
  withTelegramUpdateLock
};
