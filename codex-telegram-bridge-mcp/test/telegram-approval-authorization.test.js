"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-approval-auth-"));
const accessFile = path.join(tempDir, "access.json");
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.CODEX_TELEGRAM_BRIDGE_ACCESS_FILE = accessFile;
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");
process.env.CODEX_TELEGRAM_BROKER_STATE_FILE = path.join(tempDir, "broker-state.json");
fs.writeFileSync(accessFile, JSON.stringify({
  dmPolicy: "allowlist",
  allowFrom: ["-1001"],
  approvalByChat: { "-1001": ["999"] },
  groups: {},
  pending: {}
}));

let sentMessage = null;
let callbackIndex = 0;
const apiCalls = [];
const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  const payload = JSON.parse(options.body || "{}");
  apiCalls.push({ method, payload });

  if (method === "sendMessage") {
    sentMessage = payload;
    return telegramResponse({ message_id: 99 });
  }
  if (method === "getUpdates") {
    if (Number(payload.timeout || 0) === 0 || !sentMessage || callbackIndex >= 2) {
      return telegramResponse([]);
    }
    const userId = callbackIndex === 0 ? 777 : 999;
    callbackIndex += 1;
    return telegramResponse([callbackUpdate(100 + callbackIndex, userId)]);
  }
  return telegramResponse(true);
};

(async () => {
  const { telegramApprovalRequest } = require("../src/telegram.js");
  const result = await telegramApprovalRequest({
    chatId: "-1001",
    title: "Permission",
    message: "Run the requested operation.",
    timeoutMs: 3000
  });

  assert.match(result, /^approval: approved/m);
  assert.equal(callbackIndex, 2);
  const answers = apiCalls.filter((call) => call.method === "answerCallbackQuery");
  assert.ok(answers.some((call) => /권한이 없습니다/.test(call.payload.text)));
  assert.ok(answers.some((call) => /선택됨: 승인/.test(call.payload.text)));
  const edits = apiCalls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 1);
  assert.match(edits[0].payload.text, /선택됨: 승인/);
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

function callbackUpdate(updateId, userId) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId },
      message: {
        message_id: 99,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1001 },
        text: sentMessage.text
      },
      data: sentMessage.reply_markup.inline_keyboard[0][0].callback_data
    }
  };
}

function telegramResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}
