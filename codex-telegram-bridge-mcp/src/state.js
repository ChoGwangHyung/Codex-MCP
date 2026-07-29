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
  const file = telegramStatePath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      process.stderr.write(`codex-telegram-bridge-mcp: cannot read ${file}: ${error && error.message}\n`);
    }
    return normalizeTelegramState({});
  }
  try {
    return normalizeTelegramState(JSON.parse(raw));
  } catch (error) {
    // Preserve a content-addressed snapshot without renaming the live path.
    // Two readers can parse the same corrupt bytes concurrently; renaming here
    // could otherwise move a healthy replacement written by the first reader.
    quarantineStateFile(file, raw, error);
    return normalizeTelegramState({});
  }
}

function quarantineStateFile(file, raw, error) {
  const digest = crypto.createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 16);
  const target = `${file}.corrupt-${digest}`;
  try {
    fs.writeFileSync(target, raw, { flag: "wx", mode: 0o600 });
    restrictFilePermissions(target);
    process.stderr.write(
      `codex-telegram-bridge-mcp: ${file} was unreadable (${error && error.message}); preserved at ${target}\n`
    );
  } catch (writeError) {
    if (!writeError || writeError.code !== "EEXIST") {
      process.stderr.write(
        `codex-telegram-bridge-mcp: could not preserve unreadable state ${file}: ${writeError && writeError.message}\n`
      );
    }
  }
}

function writeTelegramState(state) {
  const file = telegramStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalizeTelegramState(state)), { mode: 0o600 });
  fs.renameSync(temp, file);
  restrictFilePermissions(file);
}

async function withTelegramStateLock(work) {
  return withFileLock(telegramStateLockPath(), work);
}

async function withTelegramUpdateLock(work) {
  return withFileLock(telegramUpdateLockPath(), work);
}

async function withFileLock(lock, work) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let handle = null;

  while (!handle) {
    try {
      handle = await fs.promises.open(lock, "wx");
      if (process.platform !== "win32") {
        await handle.chmod(0o600).catch(() => {});
      }
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
      if (!isLockContentionError(error)) throw error;
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

function isLockContentionError(error) {
  if (error && error.code === "EEXIST") return true;
  return Boolean(
    process.platform === "win32" &&
    error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}

function restrictFilePermissions(file) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Permission hardening is best effort on filesystems without POSIX modes.
  }
}

function telegramStateLockPath() {
  return `${telegramStatePath()}.lock`;
}

function telegramUpdateLockPath() {
  const tokenHash = telegramTokenHash();
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CodexTelegramBridge", "locks");
  return path.join(dir, `updates-${tokenHash}.lock`);
}

function telegramTokenHash() {
  return crypto
    .createHash("sha256")
    .update(String(process.env.TELEGRAM_BOT_TOKEN || "missing-token"))
    .digest("hex")
    .slice(0, 16);
}

// The holder pid is written into the lock, so a lock left behind by a killed
// process is reclaimed at once instead of stalling every other process for the
// full LOCK_STALE_MS window.
async function removeStaleLock(lock) {
  try {
    const stat = await fs.promises.stat(lock);
    const expired = Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
    if (!expired && !(await lockOwnerIsDead(lock))) return;
    await fs.promises.unlink(lock);
  } catch {
    // A competing process may have released the lock.
  }
}

async function lockOwnerIsDead(lock) {
  let owner;
  try {
    owner = JSON.parse(await fs.promises.readFile(lock, "utf8"));
  } catch {
    // A half-written or unreadable lock is left to the age-based path.
    return false;
  }
  const pid = Number(owner && owner.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === "ESRCH");
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
  withTelegramUpdateLock,
  withFileLock,
  telegramTokenHash
};
