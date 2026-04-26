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

assert.equal(DEFAULT_TIMEOUT_MS, 600000);

(async () => {
  const first = await acquireProviderLock("claude", 1000);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  const old = new Date(Date.now() - 5000);
  fs.utimesSync(providerLockPath("claude"), old, old);

  const second = await acquireProviderLock("claude", 2000);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  releaseProviderLock(first);
  assert.ok(fs.existsSync(providerLockPath("claude")));

  releaseProviderLock(second);
  assert.equal(fs.existsSync(providerLockPath("claude")), false);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
