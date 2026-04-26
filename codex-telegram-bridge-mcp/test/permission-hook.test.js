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
  handlePermissionHook,
  permissionDecisionOutput,
  requestTelegramPermissionApproval
} = require("../src/permission-hook.js");
const { parseApprovalDecision } = require("../src/approval.js");

assert.equal(parseApprovalDecision("approve abc123", "abc123"), "approved");
assert.equal(parseApprovalDecision("승인 abc123", "abc123"), "approved");
assert.equal(parseApprovalDecision("deny abc123", "abc123"), "denied");
assert.equal(parseApprovalDecision("거부 abc123", "abc123"), "denied");

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

let approvalCode = "";
let replied = false;
const apiCalls = [];
async function telegramApiFn(method, payload) {
  apiCalls.push({ method, payload });
  if (method === "sendMessage" && /Code \/ 코드:/.test(payload.text)) {
    approvalCode = /Code \/ 코드: ([a-f0-9]{6})/.exec(payload.text)[1];
    return { message_id: 1 };
  }
  if (method === "getUpdates" && approvalCode && !replied) {
    replied = true;
    return [{
      update_id: 10,
      message: {
        message_id: 20,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345 },
        text: `approve ${approvalCode}`,
        from: { username: "tester" }
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
  assert.ok(apiCalls.some((call) => call.method === "sendMessage"));

  approvalCode = "";
  replied = false;
  const output = await handlePermissionHook(hookInput, { telegramApiFn });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.decision.behavior, "allow");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
