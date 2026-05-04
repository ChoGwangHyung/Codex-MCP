"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-permission-hook-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

const {
  buildPermissionApprovalRequest,
  handlePostToolUseHook,
  handlePermissionHook,
  permissionDecisionOutput,
  requestTelegramPermissionApproval
} = require("../src/permission-hook.js");
const {
  approvalReplyMarkup,
  approvalRequestText,
  parseApprovalCallbackData,
  parseApprovalDecision
} = require("../src/approval.js");

assert.equal(parseApprovalDecision("approve abc123", "abc123"), "approved");
assert.equal(parseApprovalDecision("승인 abc123", "abc123"), "approved");
assert.equal(parseApprovalDecision("deny abc123", "abc123"), "denied");
assert.equal(parseApprovalDecision("거부 abc123", "abc123"), "denied");
assert.equal(parseApprovalDecision("approve", "abc123"), "approved");
assert.equal(parseApprovalDecision("거부", "abc123"), "denied");
assert.equal(parseApprovalDecision("always approve abc123", "abc123"), "always_approved");
assert.equal(parseApprovalDecision("항상 승인 abc123", "abc123"), "always_approved");
assert.equal(parseApprovalDecision("approve deadbe", "abc123"), "");
assert.equal(parseApprovalDecision("deny deadbe", "abc123"), "");
assert.equal(parseApprovalDecision("always approve deadbe", "abc123"), "");

const approvalText = approvalRequestText({ title: "Permission", message: "Run command", code: "abc123" });
assert.doesNotMatch(approvalText, /abc123/);
assert.doesNotMatch(approvalText, /Code \/ 코드/);
const approvalMarkup = approvalReplyMarkup("abc123");
assert.equal(approvalMarkup.inline_keyboard[0][0].text, "승인");
assert.equal(approvalMarkup.inline_keyboard[0][1].text, "항상 승인");
assert.equal(approvalMarkup.inline_keyboard[0][2].text, "거부");
assert.equal(parseApprovalCallbackData(approvalMarkup.inline_keyboard[0][0].callback_data, "abc123").decision, "approved");
assert.equal(parseApprovalCallbackData(approvalMarkup.inline_keyboard[0][1].callback_data, "abc123").decision, "always_approved");
assert.equal(parseApprovalCallbackData(approvalMarkup.inline_keyboard[0][2].callback_data, "abc123").decision, "denied");

const hookInput = {
  hook_event_name: "PermissionRequest",
  session_id: "session-1",
  turn_id: "turn-1",
  cwd: "D:/repo",
  tool_name: "Bash",
  tool_input: {
    description: "Need to push changes",
    command: "git push origin main"
  }
};

const request = buildPermissionApprovalRequest(hookInput);
assert.match(request.title, /Bash/);
assert.match(request.message, /git push origin main/);
assert.match(request.message, /Need to push changes/);

const allowOutput = JSON.parse(permissionDecisionOutput("allow"));
assert.equal(allowOutput.hookSpecificOutput.hookEventName, "PermissionRequest");
assert.equal(allowOutput.hookSpecificOutput.decision.behavior, "allow");

let approvalCallbackData = "";
let approvalButtonIndex = 0;
let replied = false;
const apiCalls = [];
async function telegramApiFn(method, payload) {
  apiCalls.push({ method, payload });
  if (method === "sendMessage" && payload.reply_markup && payload.reply_markup.inline_keyboard) {
    assert.doesNotMatch(payload.text, /Code \/ 코드/);
    assert.doesNotMatch(payload.text, /approve [a-f0-9]{6}/);
    approvalCallbackData = payload.reply_markup.inline_keyboard[0][approvalButtonIndex].callback_data;
    return { message_id: 1 };
  }
  if (method === "getUpdates" && approvalCallbackData && !replied) {
    replied = true;
    return [{
      update_id: 10,
      callback_query: {
        id: "callback-1",
        from: { id: 777, username: "tester" },
        data: approvalCallbackData,
        message: {
          message_id: 20,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345 }
        }
      }
    }];
  }
  return [];
}

(async () => {
  const approval = await requestTelegramPermissionApproval({
    chatIds: ["12345"],
    title: request.title,
    message: request.message,
    timeoutMs: 5000,
    telegramApiFn,
    now: () => Date.now()
  });
  assert.equal(approval.decision, "approved");
  assert.equal(approval.chatId, "12345");
  assert.equal(approval.source, "button");
  assert.ok(apiCalls.some((call) => call.method === "sendMessage"));
  assert.ok(apiCalls.some((call) => call.method === "answerCallbackQuery"));
  assert.ok(apiCalls.some((call) => call.method === "editMessageReplyMarkup"));
  assert.ok(apiCalls.some((call) => call.method === "editMessageReplyMarkup" && !Object.prototype.hasOwnProperty.call(call.payload, "reply_markup")));
  assert.ok(apiCalls.some((call) => call.method === "editMessageReplyMarkup" && call.payload.reply_markup && call.payload.reply_markup.inline_keyboard.length === 0));
  assert.ok(apiCalls.some((call) => call.method === "editMessageText" && call.payload.reply_markup && call.payload.reply_markup.inline_keyboard.length === 0));
  assert.ok(apiCalls.some((call) => call.method === "editMessageReplyMarkup" && call.payload.message_id === 20));

  approvalCallbackData = "";
  replied = false;
  const output = await handlePermissionHook(hookInput, { telegramApiFn });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");

  apiCalls.length = 0;
  approvalButtonIndex = 1;
  approvalCallbackData = "";
  replied = false;
  const always = await requestTelegramPermissionApproval({
    chatIds: ["12345"],
    title: request.title,
    message: request.message,
    timeoutMs: 5000,
    telegramApiFn,
    now: () => Date.now()
  });
  assert.equal(always.decision, "always_approved");
  approvalCallbackData = "";
  replied = false;
  const alwaysOutput = await handlePermissionHook(hookInput, { telegramApiFn });
  const alwaysParsed = JSON.parse(alwaysOutput);
  assert.equal(alwaysParsed.hookSpecificOutput.decision.behavior, "allow");
  apiCalls.length = 0;
  const cachedOutput = await handlePermissionHook(hookInput, { telegramApiFn });
  const cachedParsed = JSON.parse(cachedOutput);
  assert.equal(cachedParsed.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(apiCalls.length, 0);

  const syncTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-cli-sync-"));
  process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(syncTempDir, "telegram-state.json");
  apiCalls.length = 0;
  approvalButtonIndex = 0;
  approvalCallbackData = "";
  replied = false;
  process.env.CODEX_TELEGRAM_PERMISSION_TIMEOUT_MS = "1000";
  const fallbackOutput = await handlePermissionHook(hookInput, {
    telegramApiFn,
    now: (() => {
      let current = 0;
      return () => {
        current += 1000;
        return current;
      };
    })()
  });
  assert.match(JSON.parse(fallbackOutput).systemMessage, /timed out/);
  await handlePostToolUseHook({
    ...hookInput,
    hook_event_name: "PostToolUse",
    tool_response: { ok: true }
  }, { telegramApiFn });
  assert.ok(apiCalls.some((call) => call.method === "editMessageText" && /CLI에서 승인되어 실행/.test(call.payload.text)));
  assert.ok(apiCalls.some((call) => call.method === "editMessageText" && call.payload.reply_markup && call.payload.reply_markup.inline_keyboard.length === 0));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
