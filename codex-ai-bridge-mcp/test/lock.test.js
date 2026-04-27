"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ai-bridge-lock-"));
process.env.CODEX_AI_BRIDGE_LOCK_DIR = tempDir;
process.env.CODEX_AI_BRIDGE_LOCK_STALE_MS = "1000";

const {
  acquireProviderLock,
  providerLockPath,
  releaseProviderLock
} = require("../src/lock.js");
const { DEFAULT_TIMEOUT_MS } = require("../src/constants.js");

assert.equal(DEFAULT_TIMEOUT_MS, 0);

(async () => {
  const first = await acquireProviderLock("claude", 1000);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  await assert.rejects(
    () => acquireProviderLock("claude", 1000),
    /timed out waiting for claude provider lock/
  );
  releaseProviderLock(first);
  assert.equal(fs.existsSync(providerLockPath("claude")), false);

  const scopedA = await acquireProviderLock("claude", 1000, "workspace-a");
  const scopedB = await acquireProviderLock("claude", 1000, "workspace-b");
  assert.notEqual(providerLockPath("claude", "workspace-a"), providerLockPath("claude", "workspace-b"));
  assert.ok(fs.existsSync(providerLockPath("claude", "workspace-a")));
  assert.ok(fs.existsSync(providerLockPath("claude", "workspace-b")));
  await assert.rejects(
    () => acquireProviderLock("claude", 1000, "workspace-a"),
    /timed out waiting for claude provider lock/
  );
  releaseProviderLock(scopedA);
  releaseProviderLock(scopedB);
  assert.equal(fs.existsSync(providerLockPath("claude", "workspace-a")), false);
  assert.equal(fs.existsSync(providerLockPath("claude", "workspace-b")), false);

  const old = new Date(Date.now() - 15000);
  fs.mkdirSync(providerLockPath("claude"));
  fs.writeFileSync(path.join(providerLockPath("claude"), "owner.json"), JSON.stringify({
    ownerId: "stale-reused-pid",
    pid: process.pid,
    provider: "claude",
    createdAt: new Date(Date.now() - 15000).toISOString()
  }));
  fs.utimesSync(providerLockPath("claude"), old, old);

  const stalePidReuse = await acquireProviderLock("claude", 2000);
  assert.ok(fs.existsSync(providerLockPath("claude")));
  releaseProviderLock(stalePidReuse);
  assert.equal(fs.existsSync(providerLockPath("claude")), false);

  fs.mkdirSync(providerLockPath("claude"));
  fs.writeFileSync(path.join(providerLockPath("claude"), "owner.json"), JSON.stringify({
    ownerId: "dead-owner",
    pid: 999999,
    provider: "claude",
    createdAt: new Date(Date.now() - 15000).toISOString()
  }));
  fs.utimesSync(providerLockPath("claude"), old, old);

  const second = await acquireProviderLock("claude", 2000);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  const replacementDir = providerLockPath("claude");
  fs.rmSync(replacementDir, { recursive: true, force: true });
  fs.mkdirSync(replacementDir);
  fs.writeFileSync(path.join(replacementDir, "owner.json"), JSON.stringify({
    ownerId: "replacement",
    pid: process.pid,
    provider: "claude",
    createdAt: new Date().toISOString()
  }));

  releaseProviderLock(first);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  fs.rmSync(replacementDir, { recursive: true, force: true });
  fs.mkdirSync(replacementDir);
  fs.utimesSync(replacementDir, old, old);

  const orphanReplacement = await acquireProviderLock("claude", 2000);
  assert.ok(fs.existsSync(providerLockPath("claude")));
  releaseProviderLock(orphanReplacement);
  assert.equal(fs.existsSync(providerLockPath("claude")), false);

  releaseProviderLock(second);
  assert.equal(fs.existsSync(providerLockPath("claude")), false);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
