"use strict";

const assert = require("node:assert/strict");
const { _test } = require("../src/index.js");

const message = {
  chatId: "12345",
  text: "handle this",
  from: "@tester",
  date: "2026-04-25T00:00:00.000Z"
};

assert.equal(_test.relayEnabled(), true);
assert.equal(_test.relayReplyRequired(), true);

const multiline = _test.formatRelayPrompt(message);
assert.match(multiline, /\[Telegram chatId 12345\]/);
assert.match(multiline, /handle this/);
assert.match(multiline, /telegram_send/);
assert.match(multiline, /Required: after completing this Telegram-origin request/);
assert.doesNotMatch(multiline, /Reply via/i);
assert.doesNotMatch(multiline, /from:/i);
assert.doesNotMatch(multiline, /sent_at/i);
assert.doesNotMatch(multiline, /do not treat/i);
assert.ok(multiline.split(/\r?\n/).length <= 4);

const consoleLine = _test.formatConsoleRelayPrompt(message);
assert.match(consoleLine, /\[Telegram chatId 12345\]/);
assert.match(consoleLine, /handle this/);
assert.match(consoleLine, /telegram_send/);
assert.doesNotMatch(consoleLine, /Reply via/i);
assert.doesNotMatch(consoleLine, /from:/i);
assert.doesNotMatch(consoleLine, /sent_at/i);
assert.doesNotMatch(consoleLine, /do not treat/i);

const lineBreakMessage = {
  ...message,
  text: `line 1\nline 2\rline 3\r\nline 4${String.fromCharCode(0x2028)}line 5`
};
const lineBreakConsoleLine = _test.formatConsoleRelayPrompt(lineBreakMessage);
assert.doesNotMatch(lineBreakConsoleLine, /[\r\n\u2028\u2029]/);
assert.doesNotMatch(lineBreakConsoleLine, /\\n/);
assert.match(lineBreakConsoleLine, /line 1 \| line 2 \| line 3 \| line 4 \| line 5/);

const mediaPath = "<project-dir>\\.codex\\telegram-runtime\\downloads\\10-20-photo-file_1.jpg";
const mediaMessage = {
  ...message,
  text: [
    "사진 확인해줘",
    "",
    "Attachment: photo",
    `Local file: ${mediaPath}`
  ].join("\n"),
  attachments: [
    { type: "photo", localPath: mediaPath, mimeType: "image/jpeg" },
    { type: "document", localPath: mediaPath, mimeType: "image/jpeg" },
    { type: "document", localPath: "<project-dir>\\.codex\\telegram-runtime\\downloads\\notes.txt", mimeType: "text/plain" }
  ]
};
const mediaConsoleLine = _test.formatConsoleRelayPrompt(mediaMessage);
assert.doesNotMatch(mediaConsoleLine, /[\r\n\u2028\u2029]/);
assert.doesNotMatch(mediaConsoleLine, /\\n/);
assert.match(mediaConsoleLine, /사진 확인해줘 \| Attachment: photo \| Local file:/);
assert.match(mediaConsoleLine, /10-20-photo-file_1\.jpg/);
assert.doesNotMatch(mediaConsoleLine, /Telegram file_id/);
assert.match(mediaConsoleLine, /telegram_send/);

const mediaAppServerInput = _test.formatAppServerRelayInput(mediaMessage);
assert.equal(mediaAppServerInput.length, 2);
assert.equal(mediaAppServerInput[0].type, "text");
assert.deepEqual(mediaAppServerInput[1], { type: "localImage", path: mediaPath });

process.env.CODEX_TELEGRAM_CODEX_REPLY_REQUIRED = "0";
assert.equal(_test.relayReplyRequired(), false);
assert.doesNotMatch(_test.formatRelayPrompt(message), /telegram_send/);
assert.doesNotMatch(_test.formatConsoleRelayPrompt(message), /telegram_send/);

assert.equal(_test.isApprovalDecisionRelayMessage({
  chatId: "12345",
  text: "always approve b79df2"
}, {
  permissionPendingApprovals: {
    one: { code: "b79df2" }
  }
}), true);
assert.equal(_test.isApprovalDecisionRelayMessage({
  chatId: "12345",
  text: "always approve b79df2",
  approvalCode: "b79df2",
  approvalDecision: "always_approved"
}, {}), true);
assert.equal(_test.isApprovalDecisionRelayMessage({
  chatId: "12345",
  text: "always approve b79df2"
}, {
  permissionPendingApprovals: {
    one: { code: "abc123" }
  }
}), false);
