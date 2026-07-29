"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-orphan-callback-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.CODEX_TELEGRAM_CODEX_RELAY_ENABLED = "0";
process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_GRACE_MS = "0";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");
process.env.CODEX_TELEGRAM_BROKER_STATE_FILE = path.join(tempDir, "broker-state.json");

const apiCalls = [];
const failedMethods = new Set();
let pendingUpdates = [];
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  const payload = JSON.parse(options.body || "{}");
  apiCalls.push({ method, payload });
  if (method === "getUpdates") {
    const batch = pendingUpdates;
    pendingUpdates = [];
    return telegramResponse(batch);
  }
  if (failedMethods.has(method)) {
    return {
      ok: true,
      json: async () => ({ ok: false, description: `forced ${method} failure` })
    };
  }
  return telegramResponse(true);
};

function telegramResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

function callbackUpdate(updateId, data, messageId = 4242, messageAgeMs = 0) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data,
      from: { id: 777, first_name: "User" },
      message: {
        message_id: messageId,
        date: Math.floor((Date.now() - messageAgeMs) / 1000),
        chat: { id: 12345 },
        text: "다음 작업을 고르세요.",
        reply_markup: {
          inline_keyboard: [
            [{ text: "진행", callback_data: "ctbc:abcd1234:0" }],
            [{ text: "중단", callback_data: "ctbc:abcd1234:1" }]
          ]
        }
      }
    }
  };
}

function backdateBrokerRecord(updateId, ageMs) {
  const file = process.env.CODEX_TELEGRAM_BROKER_STATE_FILE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const record = state.records.find((item) => Number(item.updateId) === updateId);
  record.receivedAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function inboxMessages() {
  const { readTelegramState } = require("../src/state.js");
  return readTelegramState().inbox;
}

(async () => {
  const { _test } = require("../src/telegram.js");

  // A button pressed after telegram_ask already gave up must still be answered,
  // must clear the keyboard, and must reach the session through the inbox.
  pendingUpdates = [callbackUpdate(500, "ctbc:abcd1234:0")];
  await _test.pollAndProcessTelegramUpdates(0);

  const answered = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(answered.length, 1);
  assert.equal(answered[0].payload.callback_query_id, "callback-500");
  assert.match(answered[0].payload.text, /진행/);

  const edited = apiCalls.filter((call) => call.method === "editMessageText");
  assert.equal(edited.length, 1);
  assert.equal(edited[0].payload.message_id, 4242);
  assert.match(edited[0].payload.text, /선택됨: 진행/);
  assert.deepEqual(edited[0].payload.reply_markup, { inline_keyboard: [] });

  const inbox = inboxMessages();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, "진행");
  assert.equal(inbox[0].chatId, "12345");
  assert.equal(inbox[0].userId, "777");
  assert.equal(inbox[0].source, "button");
  assert.equal(inbox[0].choiceRequestId, "abcd1234");
  assert.equal(_test.isChoiceTextMessageForWaiter(inbox[0], {
    chatId: "12345",
    choices: [{ label: "진행", value: "proceed" }]
  }), false);
  assert.equal(_test.isInboxReplyMessage(inbox[0], "12345"), false);

  const completedState = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "utf8"));
  const completedRecord = completedState.records.find((record) => Number(record.updateId) === 500);
  assert.match(completedRecord.claimedBy, /^handled:orphan:/);
  const completedCallCount = apiCalls.length;
  await _test.handleOrphanCallbacks();
  assert.equal(apiCalls.length, completedCallCount);

  // Repeated taps on the same prompt are acknowledged but never relayed twice.
  apiCalls.length = 0;
  pendingUpdates = [callbackUpdate(501, "ctbc:abcd1234:0")];
  await _test.pollAndProcessTelegramUpdates(0);

  const repeated = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(repeated.length, 1);
  assert.match(repeated[0].payload.text, /이미 처리/);
  assert.equal(apiCalls.filter((call) => call.method === "editMessageText").length, 0);
  assert.equal(inboxMessages().length, 1);

  // Approval buttons belong to the permission hook, so they are only expired.
  apiCalls.length = 0;
  pendingUpdates = [{
    update_id: 502,
    callback_query: {
      id: "callback-502",
      data: "ctba:a1b2c3:approve",
      from: { id: 777 },
      message: { message_id: 4243, chat: { id: 12345 }, text: "Approval request" }
    }
  }];
  await _test.pollAndProcessTelegramUpdates(0);

  const expired = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(expired.length, 1);
  assert.match(expired[0].payload.text, /만료/);
  assert.equal(apiCalls.filter((call) => call.method === "editMessageText").length, 0);
  assert.ok(apiCalls.some((call) => call.method === "editMessageReplyMarkup"));
  assert.equal(inboxMessages().length, 1);

  // A newly pressed button on an old prompt is also stale. The broker receive
  // time alone cannot distinguish it from a current request.
  apiCalls.length = 0;
  process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_MAX_AGE_MS = "60000";
  pendingUpdates = [callbackUpdate(503, "ctbc:abcd1234:0", 4244, 2 * 60 * 60 * 1000)];
  await _test.pollAndProcessTelegramUpdates(0);

  const oldPrompt = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(oldPrompt.length, 1);
  assert.match(oldPrompt[0].payload.text, /만료/);
  assert.equal(inboxMessages().length, 1);

  // A press that sat unhandled for a long time is closed out but never
  // replayed into a session that has moved on since.
  process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_MAX_AGE_MS = "600000";
  process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_GRACE_MS = "120000";
  pendingUpdates = [callbackUpdate(504, "ctbc:abcd1234:0", 4245)];
  await _test.pollAndProcessTelegramUpdates(0);
  backdateBrokerRecord(504, 2 * 60 * 60 * 1000);

  apiCalls.length = 0;
  process.env.CODEX_TELEGRAM_ORPHAN_CALLBACK_GRACE_MS = "0";
  await _test.handleOrphanCallbacks();

  const stale = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.equal(stale.length, 1);
  assert.match(stale[0].payload.text, /만료/);
  assert.equal(inboxMessages().length, 1);

  // A transient Telegram edit failure releases both the broker claim and the
  // prompt reservation so the next monitor pass can finish the same callback.
  apiCalls.length = 0;
  failedMethods.add("editMessageText");
  failedMethods.add("editMessageReplyMarkup");
  pendingUpdates = [callbackUpdate(505, "ctbc:abcd1234:0", 4246)];
  await assert.rejects(
    () => _test.pollAndProcessTelegramUpdates(0),
    /Failed to settle an orphan Telegram choice message/
  );

  const failedState = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "utf8"));
  const failedRecord = failedState.records.find((record) => Number(record.updateId) === 505);
  assert.equal(failedRecord.claimedBy, undefined);

  failedMethods.clear();
  await _test.handleOrphanCallbacks();
  assert.equal(inboxMessages().length, 2);
  const recoveredState = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "utf8"));
  const recoveredRecord = recoveredState.records.find((record) => Number(record.updateId) === 505);
  assert.match(recoveredRecord.claimedBy, /^handled:orphan:/);
})().finally(() => {
  global.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
