"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-ask-timeout-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  if (method === "sendMessage") {
    return telegramResponse({ message_id: 60 });
  }
  return telegramResponse([]);
};

function telegramResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

(async () => {
  const { telegramAsk } = require("../src/telegram.js");
  const result = JSON.parse(await telegramAsk({
    message: "Claude gate failed. Choose next action.",
    choices: ["진행", "대기", "중단"],
    timeoutMs: 1000
  }));

  assert.equal(result.status, "timeout");
  assert.equal(result.timeout, true);
  assert.equal(result.chatId, "12345");
  assert.equal(result.messageId, 60);
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
