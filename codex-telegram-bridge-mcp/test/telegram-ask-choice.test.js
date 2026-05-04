"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-ask-choice-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

let sentMessage = null;
let callbackDelivered = false;
const apiMethods = [];
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  const payload = JSON.parse(options.body || "{}");
  apiMethods.push({ method, payload });

  if (method === "sendMessage") {
    sentMessage = payload;
    return telegramResponse({ message_id: 99 });
  }

  if (method === "getUpdates") {
    if (Number(payload.timeout || 0) === 0 || callbackDelivered || !sentMessage) {
      return telegramResponse([]);
    }
    callbackDelivered = true;
    return telegramResponse([{
      update_id: 100,
      callback_query: {
        id: "callback-1",
        from: { id: 777 },
        message: {
          message_id: 99,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345 },
          text: sentMessage.text
        },
        data: sentMessage.reply_markup.inline_keyboard[0][0].callback_data
      }
    }]);
  }

  if (method === "answerCallbackQuery" || method === "editMessageText") {
    return telegramResponse(true);
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
    message: "Claude gate failed. Choose next action.",
    choices: ["진행", "대기", "중단"],
    timeoutMs: 5000
  }));

  assert.equal(sentMessage.chat_id, "12345");
  assert.equal(sentMessage.reply_markup.inline_keyboard.length, 3);
  assert.equal(sentMessage.reply_markup.inline_keyboard[0][0].text, "진행");
  assert.equal(result.status, "selected");
  assert.equal(result.timeout, false);
  assert.equal(result.selected_label, "진행");
  assert.equal(result.selected_value, "proceed");
  assert.equal(result.chatId, "12345");
  assert.equal(result.messageId, 99);
  assert.equal(result.userId, "777");
  assert.ok(apiMethods.some((call) => call.method === "answerCallbackQuery"));
  assert.ok(apiMethods.some((call) => call.method === "editMessageText" && /선택됨: 진행/.test(call.payload.text)));
  assert.ok(apiMethods.some((call) => call.method === "editMessageText" && call.payload.reply_markup && call.payload.reply_markup.inline_keyboard.length === 0));
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
