"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-state-lock-"));
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");
process.env.LOCALAPPDATA = tempDir;
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";

const {
  readTelegramState,
  writeTelegramState,
  withTelegramStateLock,
  withTelegramUpdateLock
} = require("../src/state.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 5 }, () => withTelegramStateLock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const state = readTelegramState();
    await delay(10);
    state.lockCounter = Number(state.lockCounter || 0) + 1;
    writeTelegramState(state);
    active -= 1;
  })));

  const state = readTelegramState();
  assert.equal(maxActive, 1);
  assert.equal(state.lockCounter, 5);
  assert.equal(fs.existsSync(`${process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE}.lock`), false);

  active = 0;
  maxActive = 0;
  await Promise.all(Array.from({ length: 3 }, () => withTelegramUpdateLock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
  })));
  assert.equal(maxActive, 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
