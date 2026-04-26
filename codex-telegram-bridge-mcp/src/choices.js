"use strict";

const crypto = require("node:crypto");
const { sanitize, singleLine } = require("./util.js");

const CHOICE_CALLBACK_PREFIX = "ctbc";
const MAX_CHOICES = 12;

const VALUE_BY_LABEL = new Map([
  ["진행", "proceed"],
  ["계속", "proceed"],
  ["proceed", "proceed"],
  ["continue", "proceed"],
  ["대기", "wait"],
  ["기다림", "wait"],
  ["wait", "wait"],
  ["중단", "stop"],
  ["정지", "stop"],
  ["stop", "stop"],
  ["cancel", "stop"]
]);

function createChoiceRequestId() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeChoices(rawChoices) {
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) return [];
  if (rawChoices.length > MAX_CHOICES) {
    throw new Error(`choices must contain at most ${MAX_CHOICES} items`);
  }
  return rawChoices.map((choice, index) => normalizeChoice(choice, index));
}

function normalizeChoice(choice, index) {
  if (typeof choice === "string") {
    const label = requiredLabel(choice, index);
    return { label, value: valueForLabel(label), index };
  }
  if (!choice || typeof choice !== "object") {
    throw new Error("choices must be strings or objects");
  }
  const label = requiredLabel(choice.label || choice.title || choice.text || choice.name, index);
  const value = singleLine(choice.value || choice.id || choice.key || valueForLabel(label));
  if (!value) throw new Error(`choice ${index + 1} value is required`);
  return { label, value, index };
}

function requiredLabel(value, index) {
  const label = singleLine(value);
  if (!label) throw new Error(`choice ${index + 1} label is required`);
  return label;
}

function valueForLabel(label) {
  const normalized = normalizeChoiceText(label);
  return VALUE_BY_LABEL.get(normalized) || normalized.replace(/\s+/g, "_");
}

function normalizeChoiceText(text) {
  return sanitize(text).trim().toLowerCase();
}

function choiceReplyMarkup(requestId, choices) {
  return {
    inline_keyboard: choices.map((choice) => ([{
      text: choice.label,
      callback_data: formatChoiceCallbackData(requestId, choice.index)
    }]))
  };
}

function formatChoiceCallbackData(requestId, index) {
  return `${CHOICE_CALLBACK_PREFIX}:${requestId}:${index}`;
}

function parseChoiceCallbackData(data) {
  const match = new RegExp(`^${CHOICE_CALLBACK_PREFIX}:([a-f0-9]{8}):(\\d+)$`).exec(String(data || ""));
  if (!match) return null;
  return {
    requestId: match[1],
    index: Number(match[2])
  };
}

function findChoiceByText(choices, text) {
  const normalized = normalizeChoiceText(text);
  return choices.find((choice) => {
    return normalized === normalizeChoiceText(choice.label) ||
      normalized === normalizeChoiceText(choice.value) ||
      normalized === valueForLabel(choice.label);
  }) || null;
}

function selectedChoiceResult({ choice, chatId, messageId, userId, timestamp, source, requestId }) {
  return {
    status: "selected",
    timeout: false,
    selected_label: choice.label,
    selected_value: choice.value,
    chatId: String(chatId || ""),
    messageId: messageId === undefined || messageId === null ? "" : Number(messageId),
    userId: userId === undefined || userId === null ? "" : String(userId),
    timestamp: timestamp || new Date().toISOString(),
    source: source || "button",
    requestId
  };
}

function timeoutChoiceResult({ chatId, messageId, requestId }) {
  return {
    status: "timeout",
    timeout: true,
    chatId: String(chatId || ""),
    messageId: messageId === undefined || messageId === null ? "" : Number(messageId),
    timestamp: new Date().toISOString(),
    requestId
  };
}

function choiceSelectionText(question, label) {
  return [sanitize(question), "", `선택됨: ${sanitize(label)}`].filter(Boolean).join("\n");
}

module.exports = {
  createChoiceRequestId,
  normalizeChoices,
  choiceReplyMarkup,
  parseChoiceCallbackData,
  findChoiceByText,
  selectedChoiceResult,
  timeoutChoiceResult,
  choiceSelectionText
};
