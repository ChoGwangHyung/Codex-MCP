"use strict";

const {
  readTelegramState,
  withTelegramStateLock,
  writeTelegramState
} = require("./state.js");

const CHOICE_PROMPT_MAX = 200;
const CHOICE_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
const CHOICE_PROMPT_PROCESSING_STALE_MS = 2 * 60 * 1000;

async function markChoicePrompt(chatId, messageId, status) {
  if (!chatId || !messageId) return;
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const prompts = choicePromptsOf(state);
    prompts[choicePromptKey(chatId, messageId)] = {
      status,
      at: new Date().toISOString()
    };
    state.choicePrompts = pruneChoicePrompts(prompts);
    writeTelegramState(state);
  });
}

async function claimChoicePrompt(chatId, messageId, claimId) {
  if (!chatId || !messageId) return false;
  return withTelegramStateLock(async () => {
    const state = readTelegramState();
    const prompts = choicePromptsOf(state);
    const key = choicePromptKey(chatId, messageId);
    const current = prompts[key];
    if (current && current.status === "settled") return false;

    const currentAt = Date.parse(current && current.at || "");
    if (current && current.status === "processing" &&
        current.claimId !== claimId &&
        Number.isFinite(currentAt) &&
        Date.now() - currentAt <= CHOICE_PROMPT_PROCESSING_STALE_MS) {
      return false;
    }

    prompts[key] = {
      status: "processing",
      claimId: String(claimId || ""),
      at: new Date().toISOString()
    };
    state.choicePrompts = pruneChoicePrompts(prompts);
    writeTelegramState(state);
    return true;
  });
}

async function releaseChoicePrompt(chatId, messageId, claimId) {
  if (!chatId || !messageId || !claimId) return;
  await withTelegramStateLock(async () => {
    const state = readTelegramState();
    const prompts = choicePromptsOf(state);
    const key = choicePromptKey(chatId, messageId);
    const current = prompts[key];
    if (!current || current.status !== "processing" || current.claimId !== claimId) return;
    delete prompts[key];
    state.choicePrompts = prompts;
    writeTelegramState(state);
  });
}

function choicePromptsOf(state) {
  return state.choicePrompts && typeof state.choicePrompts === "object" &&
    !Array.isArray(state.choicePrompts)
    ? state.choicePrompts
    : {};
}

function choicePromptKey(chatId, messageId) {
  return `${String(chatId)}:${Number(messageId)}`;
}

function pruneChoicePrompts(prompts) {
  const now = Date.now();
  return Object.fromEntries(Object.entries(prompts)
    .filter(([, value]) => {
      const at = Date.parse(value && value.at || "");
      return !Number.isFinite(at) || now - at <= CHOICE_PROMPT_TTL_MS;
    })
    .sort((left, right) => String(left[1].at || "").localeCompare(String(right[1].at || "")))
    .slice(-CHOICE_PROMPT_MAX));
}

module.exports = {
  claimChoicePrompt,
  markChoicePrompt,
  releaseChoicePrompt
};
