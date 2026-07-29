"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-choice-ui-retry-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_GRACE_MS = "0";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");
process.env.CODEX_TELEGRAM_BROKER_STATE_FILE = path.join(tempDir, "broker-state.json");

let sentMessage = null;
let callbackDelivered = false;
let failEdits = true;
const apiCalls = [];
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  const payload = JSON.parse(options.body || "{}");
  apiCalls.push({ method, payload });

  if (method === "sendMessage") {
    sentMessage = payload;
    return telegramResponse({ message_id: 199 });
  }
  if (method === "getUpdates") {
    if (Number(payload.timeout || 0) === 0 || callbackDelivered || !sentMessage) {
      return telegramResponse([]);
    }
    callbackDelivered = true;
    return telegramResponse([{
      update_id: 300,
      callback_query: {
        id: "callback-300",
        data: sentMessage.reply_markup.inline_keyboard[0][0].callback_data,
        from: { id: 777 },
        message: {
          message_id: 199,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345 },
          text: sentMessage.text,
          reply_markup: sentMessage.reply_markup
        }
      }
    }]);
  }
  if (failEdits && (method === "editMessageText" || method === "editMessageReplyMarkup")) {
    return telegramFailure(`forced ${method} failure`);
  }
  return telegramResponse(true);
};

function telegramResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

function telegramFailure(description) {
  return {
    ok: true,
    json: async () => ({ ok: false, description })
  };
}

function brokerRecord() {
  const state = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "utf8"));
  return state.records.find((record) => Number(record.updateId) === 300);
}

(async () => {
  const { telegramAsk, _test } = require("../src/telegram.js");
  const result = JSON.parse(await telegramAsk({
    message: "Choose the next action.",
    choices: ["진행", "대기", "중단"],
    timeoutMs: 1000
  }));

  assert.equal(result.status, "selected");
  assert.equal(result.selected_value, "proceed");
  assert.equal(brokerRecord().claimedBy, undefined);

  const retryCallStart = apiCalls.length;
  failEdits = false;
  await _test.handleOrphanCallbacks();

  assert.match(brokerRecord().claimedBy, /^handled:orphan:/);
  assert.ok(apiCalls.slice(retryCallStart).some((call) => call.method === "editMessageReplyMarkup"));
  const state = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE, "utf8"));
  assert.equal(state.inbox.length, 0);
})().finally(() => {
  global.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
