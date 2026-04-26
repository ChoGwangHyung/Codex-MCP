"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

function providerLocksEnabled() {
  return process.env.CODEX_AI_BRIDGE_PROVIDER_LOCK !== "0";
}

async function withProviderLock(provider, timeoutMs, work) {
  if (!providerLocksEnabled()) return work();
  const lock = await acquireProviderLock(provider, timeoutMs);
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
      fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({
        ownerId,
        pid: process.pid,
        provider,
        createdAt: new Date().toISOString()
      }, null, 2));
      return { dir, ownerId };
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      removeStaleLock(dir);
      await delay(250);
    }
  }
  throw new Error(`timed out waiting for ${provider} provider lock`);
}

function releaseProviderLock(lock) {
  if (!lock || !lock.dir) return;
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
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return;
  }
  const staleMs = staleLockMs();
  if (Date.now() - stat.mtimeMs > staleMs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function staleLockMs() {
  const configured = Number(process.env.CODEX_AI_BRIDGE_LOCK_STALE_MS);
  if (Number.isInteger(configured) && configured >= 1000) return configured;
  return DEFAULT_LOCK_STALE_MS;
}

function lockIsOwnedByCurrentProcess(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock.dir, "owner.json"), "utf8"));
    return owner && owner.ownerId === lock.ownerId;
  } catch {
    return false;
  }
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
