"use strict";

const assert = require("node:assert/strict");
const {
  choiceReplyMarkup,
  choiceSelectionText,
  findChoiceByText,
  normalizeChoices,
  parseChoiceCallbackData,
  selectedChoiceResult,
  timeoutChoiceResult
} = require("../src/choices.js");

const choices = normalizeChoices(["진행", "대기", "중단"]);
assert.deepEqual(choices.map((choice) => choice.value), ["proceed", "wait", "stop"]);

const markup = choiceReplyMarkup("abcdef12", choices);
assert.equal(markup.inline_keyboard.length, 3);
assert.equal(markup.inline_keyboard[0][0].text, "진행");
assert.equal(markup.inline_keyboard[0][0].callback_data, "ctbc:abcdef12:0");
assert.deepEqual(parseChoiceCallbackData("ctbc:abcdef12:2"), { requestId: "abcdef12", index: 2 });

assert.equal(findChoiceByText(choices, "진행").value, "proceed");
assert.equal(findChoiceByText(choices, "proceed").label, "진행");
assert.equal(findChoiceByText(choices, "대기").value, "wait");
assert.equal(findChoiceByText(choices, "stop").label, "중단");
assert.equal(findChoiceByText(choices, "잘못된 입력"), null);

const selected = selectedChoiceResult({
  choice: choices[0],
  chatId: "12345",
  messageId: 99,
  userId: "777",
  timestamp: "2026-04-26T00:00:00.000Z",
  source: "button",
  requestId: "abcdef12"
});
assert.equal(selected.status, "selected");
assert.equal(selected.timeout, false);
assert.equal(selected.selected_label, "진행");
assert.equal(selected.selected_value, "proceed");
assert.equal(selected.chatId, "12345");
assert.equal(selected.messageId, 99);
assert.equal(selected.userId, "777");

const timeout = timeoutChoiceResult({ chatId: "12345", messageId: 99, requestId: "abcdef12" });
assert.equal(timeout.status, "timeout");
assert.equal(timeout.timeout, true);
assert.equal(timeout.chatId, "12345");

assert.match(choiceSelectionText("Claude gate failed. Choose.", "진행"), /선택됨: 진행/);
