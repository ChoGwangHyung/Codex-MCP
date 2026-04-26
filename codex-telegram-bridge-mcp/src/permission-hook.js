"use strict";

const {
  DEFAULT_APPROVAL_TIMEOUT_MS
} = require("./constants.js");
const {
  allowedChatIds,
  bridgeEnabled
} = require("./config.js");
const {
  readTelegramState,
  writeTelegramState
} = require("./state.js");
const { telegramApi } = require("./telegram.js");
const {
  approvalReplyMarkup,
  approvalRequestText,
  createApprovalCode,
  parseApprovalDecision,
  truncateTelegramText
} = require("./approval.js");
const {
  normalizeTimeout,
  sanitize,
  singleLine
} = require("./util.js");

const DEFAULT_POLL_TIMEOUT_SEC = 2;

function permissionDecisionOutput(behavior, message) {
  const decision = { behavior };
  if (message) decision.message = sanitize(message);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  });
}

function systemMessageOutput(message) {
  return JSON.stringify({ systemMessage: sanitize(message) });
}

async function handlePermissionHook(input, options = {}) {
  if (!input || input.hook_event_name !== "PermissionRequest") {
    return "";
  }
  if (process.env.CODEX_TELEGRAM_PERMISSION_APPROVAL_ENABLED === "0") {
    return "";
  }

  const chatIds = selectApprovalChatIds();
  if (!bridgeEnabled()) {
    return systemMessageOutput("Telegram permission approval skipped: CODEX_TELEGRAM_BRIDGE_ENABLED is not 1.");
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return systemMessageOutput("Telegram permission approval skipped: TELEGRAM_BOT_TOKEN is not configured.");
  }
  if (chatIds.length === 0) {
    return systemMessageOutput("Telegram permission approval skipped: no approval chat is allowlisted.");
  }

  const timeoutMs = normalizeTimeout(
    process.env.CODEX_TELEGRAM_PERMISSION_TIMEOUT_MS,
    DEFAULT_APPROVAL_TIMEOUT_MS
  );
  const request = buildPermissionApprovalRequest(input);
  const result = await requestTelegramPermissionApproval({
    ...request,
    chatIds,
    timeoutMs,
    telegramApiFn: options.telegramApiFn || telegramApi,
    now: options.now || (() => Date.now())
  });

  if (result.decision === "approved") {
    return permissionDecisionOutput("allow");
  }
  if (result.decision === "denied") {
    return permissionDecisionOutput("deny", `Denied by Telegram chat ${result.chatId || "unknown"}.`);
  }

  if (permissionTimeoutBehavior() === "deny") {
    return permissionDecisionOutput("deny", "Timed out waiting for Telegram approval.");
  }
  return systemMessageOutput("Telegram permission approval timed out; falling back to the normal Codex approval prompt.");
}

function selectApprovalChatIds() {
  const explicit = process.env.CODEX_TELEGRAM_APPROVAL_CHAT_IDS ||
    process.env.CODEX_TELEGRAM_APPROVAL_CHAT_ID ||
    "";
  const allowed = allowedChatIds();
  const selected = explicit
    ? explicit.split(",").map((item) => item.trim()).filter(Boolean)
    : Array.from(allowed);
  return selected.filter((chatId, index, list) => {
    const value = String(chatId);
    return allowed.has(value) && list.indexOf(chatId) === index;
  });
}

function permissionTimeoutBehavior() {
  return String(process.env.CODEX_TELEGRAM_PERMISSION_TIMEOUT_BEHAVIOR || "ask").trim().toLowerCase() === "deny"
    ? "deny"
    : "ask";
}

function buildPermissionApprovalRequest(input) {
  const toolName = singleLine(input.tool_name || "unknown");
  return {
    title: `Codex permission request: ${toolName}`,
    message: formatPermissionDetails(input)
  };
}

function formatPermissionDetails(input) {
  const toolInput = input.tool_input && typeof input.tool_input === "object"
    ? input.tool_input
    : {};
  const description = toolInput.description ? singleLine(toolInput.description) : "";
  const command = toolInput.command ? String(toolInput.command) : "";
  const lines = [
    `Tool: ${singleLine(input.tool_name || "unknown")}`,
    description ? `Reason: ${description}` : "",
    input.cwd ? `Cwd: ${singleLine(input.cwd)}` : "",
    input.session_id ? `Session: ${singleLine(input.session_id)}` : "",
    input.turn_id ? `Turn: ${singleLine(input.turn_id)}` : ""
  ].filter(Boolean);

  if (command) {
    lines.push("", "Command:", truncateBlock(command, 1600));
  } else {
    lines.push("", "Input:", truncateBlock(JSON.stringify(toolInput, null, 2), 1600));
  }
  return truncateTelegramText(lines.join("\n"));
}

function truncateBlock(text, maxLength) {
  const value = sanitize(text);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 20)}\n...[truncated]`;
}

async function requestTelegramPermissionApproval({
  chatIds,
  title,
  message,
  timeoutMs,
  telegramApiFn,
  now
}) {
  const code = createApprovalCode();
  const startedAt = now();
  await syncTelegramOffset(telegramApiFn);
  await sendApprovalRequest(telegramApiFn, chatIds, { title, message, code });

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const inboxDecision = takeMatchingInboxDecision(chatIds, code, startedAt);
    if (inboxDecision) {
      await sendApprovalResult(telegramApiFn, inboxDecision.chatId, inboxDecision.decision);
      return inboxDecision;
    }

    const remainingMs = Math.max(1000, deadline - now());
    const updates = await fetchTelegramUpdates(telegramApiFn, Math.min(DEFAULT_POLL_TIMEOUT_SEC, Math.ceil(remainingMs / 1000)));
    const updateDecision = storeUpdatesAndFindDecision(updates, chatIds, code, startedAt);
    if (updateDecision) {
      await sendApprovalResult(telegramApiFn, updateDecision.chatId, updateDecision.decision);
      return updateDecision;
    }
  }

  await sendApprovalTimeout(telegramApiFn, chatIds);
  return { decision: "timeout", code };
}

async function sendApprovalRequest(telegramApiFn, chatIds, request) {
  const text = approvalRequestText(request);
  await Promise.all(chatIds.map((chatId) => telegramApiFn("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: approvalReplyMarkup(request.code)
  })));
}

async function sendApprovalResult(telegramApiFn, chatId, decision) {
  await telegramApiFn("sendMessage", {
    chat_id: chatId,
    text: decision === "approved" ? "Approved / 승인 처리되었습니다." : "Denied / 거부 처리되었습니다.",
    disable_web_page_preview: true,
    reply_markup: { remove_keyboard: true }
  }).catch(() => {});
}

async function sendApprovalTimeout(telegramApiFn, chatIds) {
  await Promise.all(chatIds.map((chatId) => telegramApiFn("sendMessage", {
    chat_id: chatId,
    text: "Approval request timed out / 승인 요청 시간이 만료되었습니다.",
    disable_web_page_preview: true,
    reply_markup: { remove_keyboard: true }
  }).catch(() => {})));
}

async function syncTelegramOffset(telegramApiFn) {
  for (let drainCount = 0; drainCount < 100; drainCount += 1) {
    const updates = await fetchTelegramUpdates(telegramApiFn, 0);
    if (!Array.isArray(updates) || updates.length < 100) break;
  }
}

async function fetchTelegramUpdates(telegramApiFn, timeoutSeconds) {
  const state = readTelegramState();
  const updates = await telegramApiFn("getUpdates", {
    offset: Number(state.updateOffset || 0),
    timeout: timeoutSeconds,
    limit: 100,
    allowed_updates: ["message"]
  });
  const nextState = readTelegramState();
  advanceUpdateOffset(nextState, updates);
  writeTelegramState(nextState);
  return updates;
}

function advanceUpdateOffset(state, updates) {
  for (const update of Array.isArray(updates) ? updates : []) {
    if (Number.isFinite(update.update_id)) {
      state.updateOffset = Math.max(Number(state.updateOffset || 0), update.update_id + 1);
    }
  }
}

function takeMatchingInboxDecision(chatIds, code, startedAt) {
  const selected = new Set(chatIds.map(String));
  const state = readTelegramState();
  const index = state.inbox.findIndex((message) => {
    if (!selected.has(String(message.chatId))) return false;
    if (!isMessageAfter(message, startedAt)) return false;
    return Boolean(parseApprovalDecision(message.text, code));
  });
  if (index < 0) return null;
  const [message] = state.inbox.splice(index, 1);
  writeTelegramState(state);
  return {
    decision: parseApprovalDecision(message.text, code),
    chatId: String(message.chatId),
    code,
    text: message.text
  };
}

function storeUpdatesAndFindDecision(updates, chatIds, code, startedAt) {
  const selected = new Set(chatIds.map(String));
  const allowed = allowedChatIds();
  const state = readTelegramState();
  const seen = new Set(state.inbox.map((message) => message.id));
  let decision = null;

  for (const update of Array.isArray(updates) ? updates : []) {
    const message = messageFromUpdate(update);
    if (!message || !allowed.has(message.chatId)) continue;

    if (selected.has(message.chatId) && isMessageAfter(message, startedAt)) {
      const parsedDecision = parseApprovalDecision(message.text, code);
      if (parsedDecision) {
        decision = {
          decision: parsedDecision,
          chatId: message.chatId,
          code,
          text: message.text
        };
        continue;
      }
    }

    if (!seen.has(message.id)) {
      seen.add(message.id);
      state.inbox.push(message);
    }
  }

  writeTelegramState(state);
  return decision;
}

function messageFromUpdate(update) {
  const raw = update && update.message;
  const chatId = raw && raw.chat && String(raw.chat.id);
  const text = raw && typeof raw.text === "string" ? sanitize(raw.text) : "";
  if (!chatId || !text) return null;
  return {
    id: `${Number(update.update_id || 0)}:${Number(raw.message_id || 0)}`,
    updateId: Number(update.update_id || 0),
    messageId: Number(raw.message_id || 0),
    chatId,
    text,
    date: raw.date ? new Date(Number(raw.date) * 1000).toISOString() : "",
    receivedAt: new Date().toISOString(),
    from: displayName(raw)
  };
}

function isMessageAfter(message, startedAt) {
  const receivedAt = Date.parse(message.receivedAt || message.date || "");
  return !Number.isFinite(receivedAt) || receivedAt >= startedAt;
}

function displayName(message) {
  const from = message.from || {};
  return [from.username && `@${from.username}`, from.first_name, from.last_name]
    .filter(Boolean)
    .join(" ");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function runCli() {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = await handlePermissionHook(input);
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stdout.write(`${systemMessageOutput(`Telegram permission approval unavailable: ${error.message || "unknown error"}`)}\n`);
  }
}

module.exports = {
  handlePermissionHook,
  buildPermissionApprovalRequest,
  formatPermissionDetails,
  permissionDecisionOutput,
  requestTelegramPermissionApproval,
  selectApprovalChatIds,
  systemMessageOutput,
  runCli
};
