"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
const ORPHAN_LOCK_GRACE_MS = 10 * 1000;

function providerLocksEnabled() {
  return process.env.CODEX_AI_BRIDGE_PROVIDER_LOCK !== "0";
}

async function withProviderLock(provider, timeoutMs, work) {
  if (!providerLocksEnabled()) return work();
  const lock = await acquireProviderLock(provider, timeoutMs);
  startLockHeartbeat(lock);
  try {
    return await work();
  } finally {
    releaseProviderLock(lock);
  }
}

async function acquireProviderLock(provider, timeoutMs) {
  const dir = providerLockPath(provider);
  const deadline = Date.now() + lockWaitMs(timeoutMs);
  const ownerId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      removeStaleLock(dir);
      await delay(250);
      continue;
    }

    writeLockOwner(dir, {
      ownerId,
      pid: process.pid,
      provider,
      createdAt: new Date().toISOString()
    });
    return { dir, ownerId };
  }
  throw new Error(`timed out waiting for ${provider} provider lock`);
}

function releaseProviderLock(lock) {
  if (!lock || !lock.dir) return;
  stopLockHeartbeat(lock);
  if (!lockIsOwnedByCurrentProcess(lock)) return;
  fs.rmSync(lock.dir, { recursive: true, force: true });
}

function providerLockPath(provider) {
  const base = process.env.CODEX_AI_BRIDGE_LOCK_DIR ||
    path.join(os.tmpdir(), "codex-ai-bridge-mcp-locks");
  return path.join(base, safeLockName(provider));
}

function lockWaitMs(timeoutMs) {
  const configured = Number(process.env.CODEX_AI_BRIDGE_LOCK_WAIT_MS);
  if (Number.isInteger(configured) && configured >= 1000) return configured;
  return Math.max(1000, Number(timeoutMs || 0));
}

function removeStaleLock(dir) {
  const snapshot = lockSnapshot(dir);
  if (!snapshot) return;

  const ageMs = Date.now() - snapshot.mtimeMs;
  if (snapshot.owner) {
    if (!ownerPidIsDead(snapshot.owner) && ageMs < staleLockMs()) return;
  } else if (ageMs < ORPHAN_LOCK_GRACE_MS) {
    return;
  }

  removeLockDirIfUnchanged(dir, snapshot);
}

function staleLockMs() {
  const configured = Number(process.env.CODEX_AI_BRIDGE_LOCK_STALE_MS);
  if (Number.isInteger(configured) && configured >= 1000) return configured;
  return DEFAULT_LOCK_STALE_MS;
}

function lockIsOwnedByCurrentProcess(lock) {
  try {
    const owner = readLockOwner(lock.dir);
    return owner && owner.ownerId === lock.ownerId;
  } catch {
    return false;
  }
}

function writeLockOwner(dir, owner) {
  const ownerFile = path.join(dir, "owner.json");
  const tempFile = path.join(dir, `owner.${owner.ownerId}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(owner, null, 2));
    fs.renameSync(tempFile, ownerFile);
  } catch (error) {
    fs.rmSync(tempFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function readLockOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function lockSnapshot(dir) {
  try {
    const stat = fs.statSync(dir);
    return {
      mtimeMs: stat.mtimeMs,
      owner: readLockOwner(dir)
    };
  } catch {
    return null;
  }
}

function ownerPidIsDead(owner) {
  const pid = Number(owner && owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error && error.code === "ESRCH";
  }
}

function removeLockDirIfUnchanged(dir, snapshot) {
  const current = lockSnapshot(dir);
  if (!sameLockSnapshot(snapshot, current)) return;

  const stalePath = `${dir}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.renameSync(dir, stalePath);
  } catch {
    return;
  }

  const renamed = lockSnapshot(stalePath);
  if (!sameLockSnapshot(snapshot, renamed)) {
    try {
      if (!fs.existsSync(dir)) fs.renameSync(stalePath, dir);
    } catch {
      // Best-effort restore; a future acquire will clean up once the owner is dead.
    }
    return;
  }
  fs.rmSync(stalePath, { recursive: true, force: true });
}

function sameLockSnapshot(left, right) {
  if (!left || !right) return false;
  if (left.mtimeMs !== right.mtimeMs) return false;
  if (Boolean(left.owner) !== Boolean(right.owner)) return false;
  if (!left.owner && !right.owner) return true;
  return left.owner.ownerId === right.owner.ownerId &&
    left.owner.createdAt === right.owner.createdAt &&
    Number(left.owner.pid) === Number(right.owner.pid);
}

function startLockHeartbeat(lock) {
  if (!lock || !lock.dir) return;
  const intervalMs = lockHeartbeatMs();
  lock.heartbeat = setInterval(() => touchLock(lock), intervalMs);
  if (typeof lock.heartbeat.unref === "function") lock.heartbeat.unref();
  touchLock(lock);
}

function stopLockHeartbeat(lock) {
  if (lock && lock.heartbeat) {
    clearInterval(lock.heartbeat);
    lock.heartbeat = null;
  }
}

function touchLock(lock) {
  try {
    if (!lockIsOwnedByCurrentProcess(lock)) return;
    const now = new Date();
    fs.utimesSync(lock.dir, now, now);
    fs.utimesSync(path.join(lock.dir, "owner.json"), now, now);
  } catch {
    // Heartbeat failure is non-fatal; release still verifies ownership.
  }
}

function lockHeartbeatMs() {
  return Math.max(1000, Math.min(60000, Math.floor(staleLockMs() / 3)));
}

function safeLockName(value) {
  return String(value || "provider").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  withProviderLock,
  providerLockPath,
  providerLocksEnabled,
  acquireProviderLock,
  releaseProviderLock
};
