"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-state-recovery-"));
const stateFile = path.join(tempDir, "telegram-state.json");
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = stateFile;
process.env.LOCALAPPDATA = tempDir;
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";

const { readTelegramState, writeTelegramState, withFileLock } = require("../src/state.js");

(async () => {
  // A corrupt state file is preserved instead of being silently discarded.
  // The live path is not renamed because another process may already have
  // replaced it after this reader loaded the corrupt bytes.
  fs.writeFileSync(stateFile, '{"inbox":[{"id":"1"', "utf8");
  const recovered = readTelegramState();
  assert.deepEqual(recovered.inbox, []);
  assert.equal(recovered.updateOffset, 0);
  assert.equal(fs.existsSync(stateFile), true, "the live path is left untouched until the next state write");
  const quarantined = fs.readdirSync(tempDir).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, "exactly one quarantine copy is kept");
  assert.match(
    fs.readFileSync(path.join(tempDir, quarantined[0]), "utf8"),
    /"inbox"/,
    "the original bytes survive"
  );
  readTelegramState();
  assert.equal(
    fs.readdirSync(tempDir).filter((name) => name.includes(".corrupt-")).length,
    1,
    "repeated readers reuse the content-addressed quarantine copy"
  );

  writeTelegramState({ inbox: [], updateOffset: 42 });
  assert.equal(readTelegramState().updateOffset, 42, "a healthy file still round-trips");

  // A lock left behind by a process that is gone is reclaimed immediately
  // rather than after the two minute staleness window.
  const lock = path.join(tempDir, "dead-owner.lock");
  const deadPid = await findUnusedPid();
  fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }));
  const startedAt = Date.now();
  const acquired = await withFileLock(lock, async () => "acquired");
  assert.equal(acquired, "acquired");
  assert.ok(Date.now() - startedAt < 5000, "a dead owner does not force the stale-lock wait");
  assert.equal(fs.existsSync(lock), false, "the lock is released afterwards");

  // The pid check must only reclaim dead owners. A fresh lock whose owner is
  // alive still waits for the existing age-based staleness window, so this only
  // asserts that it is not taken immediately.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const contended = withFileLock(lock, async () => "stolen");
  const outcome = await Promise.race([
    contended.then(() => "stolen"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 1000))
  ]);
  assert.equal(outcome, "waiting", "a live owner is not reclaimed by the pid check");
  contended.catch(() => {});
  fs.rmSync(lock, { force: true });

  fs.rmSync(tempDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function findUnusedPid() {
  for (let candidate = 60000; candidate < 60200; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find an unused pid for the test");
}
