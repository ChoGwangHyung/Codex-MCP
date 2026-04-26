"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-ask-text-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

let sentMessage = null;
let replyDelivered = false;
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  const payload = JSON.parse(options.body || "{}");

  if (method === "sendMessage") {
    sentMessage = payload;
    return telegramResponse({ message_id: 50 });
  }

  if (method === "getUpdates") {
    if (Number(payload.timeout || 0) === 0 || replyDelivered || !sentMessage) {
      return telegramResponse([]);
    }
    replyDelivered = true;
    return telegramResponse([{
      update_id: 200,
      message: {
        message_id: 51,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345 },
        text: "대기",
        from: { id: 888, username: "tester" }
      }
    }]);
  }

  return telegramResponse(true);
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
    question: "Claude gate failed. Choose next action.",
    options: ["진행", "대기", "중단"],
    timeoutMs: 5000
  }));

  assert.equal(result.status, "selected");
  assert.equal(result.timeout, false);
  assert.equal(result.selected_label, "대기");
  assert.equal(result.selected_value, "wait");
  assert.equal(result.source, "text");
  assert.equal(result.userId, "888");
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
