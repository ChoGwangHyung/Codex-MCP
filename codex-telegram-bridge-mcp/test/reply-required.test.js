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
assert.match(multiline, /chatId 12345/);
assert.doesNotMatch(multiline, /from:/i);
assert.doesNotMatch(multiline, /sent_at/i);
assert.doesNotMatch(multiline, /do not treat/i);
assert.ok(multiline.split(/\r?\n/).length <= 3);
assert.ok(multiline.length <= message.text.length + 90);

const consoleLine = _test.formatConsoleRelayPrompt(message);
assert.match(consoleLine, /\[Telegram chatId 12345\]/);
assert.match(consoleLine, /handle this/);
assert.match(consoleLine, /telegram_send/);
assert.match(consoleLine, /chatId 12345/);
assert.doesNotMatch(consoleLine, /from:/i);
assert.doesNotMatch(consoleLine, /sent_at/i);
assert.doesNotMatch(consoleLine, /do not treat/i);
assert.ok(consoleLine.length <= message.text.length + 90);
