"use strict";

const crypto = require("node:crypto");
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
  parseApprovalCallbackData,
  parseApprovalDecision,
  truncateTelegramText
} = require("./approval.js");
const {
  normalizeTimeout,
  sanitize,
  singleLine
} = require("./util.js");

const DEFAULT_POLL_TIMEOUT_SEC = 2;
const MAX_ALWAYS_APPROVALS = 200;

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
  const approvalKey = permissionApprovalKey(input);
  if (hasAlwaysApproval(approvalKey)) {
    return permissionDecisionOutput("allow");
  }
  const result = await requestTelegramPermissionApproval({
    ...request,
    chatIds,
    timeoutMs,
    approvalKey,
    telegramApiFn: options.telegramApiFn || telegramApi,
    now: options.now || (() => Date.now())
  });

  if (result.decision === "always_approved") {
    rememberAlwaysApproval(input, result);
    return permissionDecisionOutput("allow");
  }
  if (result.decision === "approved") {
    return permissionDecisionOutput("allow");
  }
  if (result.decision === "denied") {
    return permissionDecisionOutput("deny", `Denied by Telegram chat ${result.chatId || "unknown"}.`);
  }

  if (permissionTimeoutBehavior() === "deny") {
    forgetPendingApproval(approvalKey);
    return permissionDecisionOutput("deny", "Timed out waiting for Telegram approval.");
  }
  return systemMessageOutput("Telegram permission approval timed out; falling back to the normal Codex approval prompt.");
}

async function handlePostToolUseHook(input, options = {}) {
  if (!input || input.hook_event_name !== "PostToolUse") {
    return "";
  }
  if (process.env.CODEX_TELEGRAM_CLI_APPROVAL_SYNC_ENABLED === "0") {
    return "";
  }
  if (!bridgeEnabled() || !process.env.TELEGRAM_BOT_TOKEN) {
    return "";
  }
  const approvalKey = permissionApprovalKey(input);
  const pending = takePendingApproval(approvalKey);
  if (!pending) return "";
  await markApprovalHandledByCli(options.telegramApiFn || telegramApi, pending);
  return "";
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
  approvalKey,
  telegramApiFn,
  now
}) {
  const code = createApprovalCode();
  const startedAt = now();
  await syncTelegramOffset(telegramApiFn);
  const sentMessages = await sendApprovalRequest(telegramApiFn, chatIds, { title, message, code, approvalKey });
  rememberPendingApproval({ approvalKey, code, title, message, sentMessages, timeoutMs });

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const inboxDecision = takeMatchingInboxDecision(chatIds, code, startedAt);
    if (inboxDecision) {
      await sendApprovalResult(telegramApiFn, inboxDecision, sentMessages);
      forgetPendingApproval(approvalKey);
      return inboxDecision;
    }

    const remainingMs = Math.max(1000, deadline - now());
    const updates = await fetchTelegramUpdates(telegramApiFn, Math.min(DEFAULT_POLL_TIMEOUT_SEC, Math.ceil(remainingMs / 1000)));
    const updateDecision = storeUpdatesAndFindDecision(updates, chatIds, code, startedAt);
    if (updateDecision) {
      await sendApprovalResult(telegramApiFn, updateDecision, sentMessages);
      forgetPendingApproval(approvalKey);
      return updateDecision;
    }
  }

  await sendApprovalTimeout(telegramApiFn, chatIds, sentMessages);
  return { decision: "timeout", code };
}

async function sendApprovalRequest(telegramApiFn, chatIds, request) {
  const text = approvalRequestText(request);
  return Promise.all(chatIds.map(async (chatId) => {
    const sent = await telegramApiFn("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: approvalReplyMarkup(request.code)
    });
    return { chatId: String(chatId), messageId: sent && sent.message_id, text };
  }));
}

async function sendApprovalResult(telegramApiFn, result, sentMessages) {
  const text = approvalResultText(result.decision);
  const messages = approvalMessagesForResult(sentMessages, result);
  if (result.callbackQueryId) {
    await answerApprovalCallback(telegramApiFn, result.callbackQueryId, text);
  }
  await markApprovalMessagesSettled(telegramApiFn, messages, result.decision);
  if (!result.callbackQueryId) {
    await telegramApiFn("sendMessage", {
      chat_id: result.chatId,
      text,
      disable_web_page_preview: true
    }).catch(() => {});
  }
}

function approvalResultText(decision) {
  if (decision === "always_approved") return "항상 승인 처리되었습니다.";
  return decision === "approved" ? "승인 처리되었습니다." : "거부 처리되었습니다.";
}

async function sendApprovalTimeout(telegramApiFn, chatIds, sentMessages) {
  await markApprovalMessagesSettled(telegramApiFn, sentMessages, "timeout");
  await Promise.all(chatIds.map((chatId) => telegramApiFn("sendMessage", {
    chat_id: chatId,
    text: "Approval request timed out / 승인 요청 시간이 만료되었습니다.",
    disable_web_page_preview: true
  }).catch(() => {})));
}

function approvalMessagesForResult(sentMessages, result) {
  const messages = Array.isArray(sentMessages) ? [...sentMessages] : [];
  if (result && result.chatId && result.messageId) {
    messages.push({
      chatId: String(result.chatId),
      messageId: result.messageId
    });
  }
  return dedupeTelegramMessages(messages);
}

async function answerApprovalCallback(telegramApiFn, callbackQueryId, text) {
  await telegramApiFn("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  }).catch(() => {});
}

async function markApprovalMessagesSettled(telegramApiFn, sentMessages, decision) {
  await Promise.all(dedupeTelegramMessages(sentMessages).map(async (message) => {
    const text = approvalSettledText(message.text, decision);
    let updated = false;
    if (text) {
      updated = await editApprovalMessageText(telegramApiFn, message, text);
    }
    if (!updated) {
      await clearOneApprovalButtons(telegramApiFn, message);
    }
  }));
}

async function editApprovalMessageText(telegramApiFn, message, text) {
  try {
    await telegramApiFn("editMessageText", {
      chat_id: message.chatId,
      message_id: message.messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: emptyInlineKeyboard()
    });
    return true;
  } catch {
    return false;
  }
}

function approvalSettledText(originalText, decision) {
  const base = sanitize(originalText || "");
  if (!base) return "";
  const status = decision === "timeout"
    ? "처리됨: 승인 요청 시간이 만료되었습니다."
    : `처리됨: ${approvalResultText(decision)}`;
  return truncateTelegramText([base, "", status].join("\n"));
}

async function clearApprovalButtons(telegramApiFn, sentMessages) {
  await Promise.all(dedupeTelegramMessages(sentMessages).map((message) => clearOneApprovalButtons(telegramApiFn, message)));
}

async function clearOneApprovalButtons(telegramApiFn, message) {
  const payload = {
    chat_id: message.chatId,
    message_id: message.messageId
  };
  await telegramApiFn("editMessageReplyMarkup", {
    ...payload,
    reply_markup: emptyInlineKeyboard()
  }).catch(() => {});
  await telegramApiFn("editMessageReplyMarkup", payload).catch(() => {});
}

function emptyInlineKeyboard() {
  return { inline_keyboard: [] };
}

function dedupeTelegramMessages(messages) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    if (!message || !message.chatId || !message.messageId) return false;
    const key = `${message.chatId}:${message.messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function markApprovalHandledByCli(telegramApiFn, pending) {
  const text = truncateTelegramText([
    sanitize(pending.text || approvalRequestText(pending)),
    "",
    "처리됨: CLI에서 승인되어 실행되었습니다."
  ].join("\n"));
  await Promise.all((pending.sentMessages || []).map(async (message) => {
    if (!message || !message.chatId || !message.messageId) return;
    await telegramApiFn("editMessageText", {
      chat_id: message.chatId,
      message_id: message.messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: emptyInlineKeyboard()
    }).catch(() => clearOneApprovalButtons(telegramApiFn, message));
  }));
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
    allowed_updates: ["message", "callback_query"]
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
    const callbackDecision = approvalCallbackFromUpdate(update, selected, code);
    if (callbackDecision) {
      decision = callbackDecision;
      continue;
    }

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

function approvalCallbackFromUpdate(update, selected, code) {
  const callback = update && update.callback_query;
  const parsed = callback && parseApprovalCallbackData(callback.data, code);
  const chatId = callback && callback.message && callback.message.chat && String(callback.message.chat.id);
  if (!parsed || !chatId || !selected.has(chatId) || !allowedChatIds().has(chatId)) return null;
  return {
    decision: parsed.decision,
    chatId,
    code: parsed.code,
    source: "button",
    callbackQueryId: callback.id,
    messageId: callback.message && callback.message.message_id,
    userId: callback.from && callback.from.id !== undefined ? String(callback.from.id) : ""
  };
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

function permissionApprovalKey(input) {
  const signature = {
    sessionId: singleLine(input && input.session_id || ""),
    cwd: singleLine(input && input.cwd || ""),
    toolName: singleLine(input && input.tool_name || "unknown"),
    toolInput: input && input.tool_input !== undefined ? input.tool_input : null
  };
  return crypto.createHash("sha256").update(stableStringify(signature)).digest("hex");
}

function hasAlwaysApproval(key) {
  if (!key || process.env.CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED === "0") return false;
  const state = readTelegramState();
  const approvals = state.permissionAlwaysApprovals && typeof state.permissionAlwaysApprovals === "object"
    ? state.permissionAlwaysApprovals
    : {};
  return Boolean(approvals[key]);
}

function rememberPendingApproval({ approvalKey, code, title, message, sentMessages, timeoutMs }) {
  if (!approvalKey) return;
  const state = readTelegramState();
  const pending = state.permissionPendingApprovals && typeof state.permissionPendingApprovals === "object"
    ? state.permissionPendingApprovals
    : {};
  pending[approvalKey] = {
    key: approvalKey,
    code,
    title,
    message,
    text: approvalRequestText({ title, message }),
    sentMessages: Array.isArray(sentMessages) ? sentMessages : [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(Number(timeoutMs || 0), 0) + 15 * 60 * 1000).toISOString()
  };
  state.permissionPendingApprovals = prunePendingApprovals(pending);
  writeTelegramState(state);
}

function takePendingApproval(approvalKey) {
  if (!approvalKey) return null;
  const state = readTelegramState();
  const pending = state.permissionPendingApprovals && typeof state.permissionPendingApprovals === "object"
    ? state.permissionPendingApprovals
    : {};
  const entry = pending[approvalKey] || null;
  if (!entry) return null;
  delete pending[approvalKey];
  state.permissionPendingApprovals = pending;
  writeTelegramState(state);
  return entry;
}

function forgetPendingApproval(approvalKey) {
  if (!approvalKey) return;
  const state = readTelegramState();
  const pending = state.permissionPendingApprovals && typeof state.permissionPendingApprovals === "object"
    ? state.permissionPendingApprovals
    : {};
  if (!pending[approvalKey]) return;
  delete pending[approvalKey];
  state.permissionPendingApprovals = pending;
  writeTelegramState(state);
}

function prunePendingApprovals(pending) {
  const now = Date.now();
  return Object.fromEntries(Object.entries(pending)
    .filter(([, value]) => {
      const expiresAt = Date.parse(value && value.expiresAt || "");
      return !Number.isFinite(expiresAt) || expiresAt >= now;
    })
    .sort((left, right) => String(left[1].createdAt || "").localeCompare(String(right[1].createdAt || "")))
    .slice(-MAX_ALWAYS_APPROVALS));
}

function rememberAlwaysApproval(input, result) {
  if (process.env.CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED === "0") return;
  const key = permissionApprovalKey(input);
  const state = readTelegramState();
  const approvals = state.permissionAlwaysApprovals && typeof state.permissionAlwaysApprovals === "object"
    ? state.permissionAlwaysApprovals
    : {};
  approvals[key] = {
    key,
    scope: "session_exact_request",
    sessionId: singleLine(input && input.session_id || ""),
    cwd: singleLine(input && input.cwd || ""),
    toolName: singleLine(input && input.tool_name || "unknown"),
    chatId: result && result.chatId ? String(result.chatId) : "",
    userId: result && result.userId ? String(result.userId) : "",
    approvedAt: new Date().toISOString()
  };
  state.permissionAlwaysApprovals = pruneAlwaysApprovals(approvals);
  writeTelegramState(state);
}

function pruneAlwaysApprovals(approvals) {
  return Object.fromEntries(Object.entries(approvals)
    .sort((left, right) => String(left[1].approvedAt || "").localeCompare(String(right[1].approvedAt || "")))
    .slice(-MAX_ALWAYS_APPROVALS));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
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
    const output = input.hook_event_name === "PostToolUse"
      ? await handlePostToolUseHook(input)
      : await handlePermissionHook(input);
    if (output) process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stdout.write(`${systemMessageOutput(`Telegram permission approval unavailable: ${error.message || "unknown error"}`)}\n`);
  }
}

module.exports = {
  handlePermissionHook,
  handlePostToolUseHook,
  buildPermissionApprovalRequest,
  formatPermissionDetails,
  permissionDecisionOutput,
  requestTelegramPermissionApproval,
  selectApprovalChatIds,
  systemMessageOutput,
  runCli
};
