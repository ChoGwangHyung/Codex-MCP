"use strict";

const readline = require("node:readline");
const {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION
} = require("./constants.js");
const {
  allowedChatIds,
  bridgeEnabled,
  relayEnabled,
  telegramAccessPath,
  telegramConfigDir,
  telegramEnabled,
  telegramEnvPath
} = require("./config.js");
const {
  scheduleRelayPendingMessages,
  startTelegramRelay,
  telegramRelayStatus
} = require("./relay.js");
const {
  maybeInstallPermissionHook,
  permissionHookStatus
} = require("./hook-install.js");
const {
  setRelayHooks,
  startTelegramMonitor,
  telegramApi,
  telegramApprovalRequest,
  telegramAsk,
  telegramInboxRead,
  telegramMonitorStatus,
  telegramSend,
  telegramSendDocument,
  telegramSendFile,
  telegramSendPhoto,
  telegramWaitReply
} = require("./telegram.js");
const { maskToken, sanitize } = require("./util.js");

setRelayHooks({
  start: startTelegramRelay,
  schedule: scheduleRelayPendingMessages
});

const tools = [
  tool("telegram_send", "Send a message to an allowlisted Telegram chat.", {
    chatId: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
    disableWebPagePreview: { type: "boolean", default: false }
  }, ["text"]),
  tool("telegram_send_file", "Send any file to an allowlisted chat from a local path, URL, or file_id. Default choice for non-images.", mediaToolSchema({
    filename: { type: "string", minLength: 1, description: "Display filename for local uploads." }
  }), []),
  tool("telegram_send_photo", "Send an image to an allowlisted chat so it renders inline rather than as an attachment.", mediaToolSchema(), []),
  tool("telegram_send_document", "Alias of telegram_send_file, kept for compatibility. Prefer telegram_send_file.", mediaToolSchema({
    filename: { type: "string", minLength: 1, description: "Display filename for local uploads." }
  }), []),
  tool("telegram_wait_reply", "Wait for the next Telegram message from an allowlisted chat.", {
    chatId: { type: "string", minLength: 1, description: "Optional when exactly one chat is allowlisted." },
    timeoutMs: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_TELEGRAM_TIMEOUT_MS },
    ignoreExisting: {
      type: "boolean",
      default: true,
      description: "Discard queued messages before waiting."
    }
  }, []),
  tool("telegram_ask", "Ask an allowlisted chat a question and wait for one reply or inline button choice. Prefer `text` and `choices`; `message`/`question` and `options`/`timeout` are accepted aliases.", {
    type: "object",
    additionalProperties: false,
    properties: {
      chatId: { type: "string", minLength: 1, description: "Optional when exactly one chat is allowlisted." },
      text: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
      question: { type: "string", minLength: 1 },
      choices: choiceArraySchema(),
      options: choiceArraySchema(),
      disableWebPagePreview: { type: "boolean", default: false },
      timeout: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_TELEGRAM_TIMEOUT_MS },
      timeoutMs: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_TELEGRAM_TIMEOUT_MS }
    },
    oneOf: [
      { required: ["text"] },
      { required: ["message"] },
      { required: ["question"] }
    ]
  }, []),
  tool("telegram_inbox_read", "Read messages captured by the automatic Telegram receive monitor.", {
    chatId: { type: "string", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    consume: { type: "boolean", default: false }
  }, []),
  tool("telegram_monitor_status", "Check automatic Telegram receive monitor and inbox status.", {}, []),
  tool("telegram_relay_status", "Check Telegram-to-Codex automatic relay status.", {}, []),
  tool("telegram_approval_request", "Send an MCP-level approval request to Telegram and wait for approve/deny response.", {
    chatId: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    message: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_APPROVAL_TIMEOUT_MS }
  }, ["chatId", "title", "message"]),
  tool("telegram_bridge_health", "Check Telegram bridge configuration.", {
    timeoutMs: { type: "integer", minimum: 1000, maximum: 60000, default: 10000 }
  }, [])
];

function tool(name, description, propertiesOrSchema, required = []) {
  const inputSchema = propertiesOrSchema.type === "object" && propertiesOrSchema.properties
    ? propertiesOrSchema
    : {
        type: "object",
        additionalProperties: false,
        properties: propertiesOrSchema,
        required
      };
  return {
    name,
    description,
    inputSchema
  };
}

function choiceArraySchema() {
  return {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: {
      anyOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
            name: { type: "string", minLength: 1 },
            value: { type: "string", minLength: 1 },
            id: { type: "string", minLength: 1 },
            key: { type: "string", minLength: 1 }
          },
          anyOf: [
            { required: ["label"] },
            { required: ["title"] },
            { required: ["text"] },
            { required: ["name"] }
          ]
        }
      ]
    }
  };
}

function mediaToolSchema(extra = {}) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      chatId: { type: "string", minLength: 1, description: "Optional when exactly one chat is allowlisted." },
      path: { type: "string", minLength: 1, description: "Local file to upload." },
      url: { type: "string", minLength: 1, description: "Public HTTP(S) URL for Telegram to fetch." },
      fileId: { type: "string", minLength: 1, description: "Existing Telegram file_id to resend." },
      caption: { type: "string", minLength: 1 },
      disableNotification: { type: "boolean", default: false },
      protectContent: { type: "boolean", default: false },
      ...extra
    },
    oneOf: [
      { required: ["path"] },
      { required: ["url"] },
      { required: ["fileId"] }
    ]
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message, data) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function healthCheck(args = {}) {
  const hook = permissionHookStatus();
  let bot = null;
  let apiError = "";
  if (telegramEnabled()) {
    try {
      bot = await telegramApi("getMe", {}, { timeoutMs: args.timeoutMs });
    } catch (error) {
      apiError = sanitize(error && error.message || "Telegram API unavailable");
    }
  }
  return [
    `telegram: ${telegramEnabled() && !apiError ? "configured" : "disabled, incomplete, or unavailable"}`,
    bot && bot.username ? `bot: @${sanitize(bot.username)}` : null,
    apiError ? `api_error: ${apiError}` : null,
    `config_dir: ${telegramConfigDir()}`,
    `env_file: ${telegramEnvPath()}`,
    `access_file: ${telegramAccessPath()}`,
    `token: ${process.env.TELEGRAM_BOT_TOKEN ? maskToken(process.env.TELEGRAM_BOT_TOKEN) : "not set"}`,
    `enabled: ${bridgeEnabled() ? "yes" : "no"}`,
    `allowed_chats: ${allowedChatIds().size}`,
    `codex_relay: ${relayEnabled() ? "enabled" : "disabled"}`,
    `codex_relay_auto_reply: stop_hook`,
    `codex_hook: ${hook.installed ? "installed" : "not installed"}`,
    `codex_hook_config: ${hook.path}`
  ].filter(Boolean).join("\n");
}

async function callTool(name, args) {
  if (name === "telegram_send") return textResult(await telegramSend(args || {}));
  if (name === "telegram_send_file") return textResult(await telegramSendFile(args || {}));
  if (name === "telegram_send_photo") return textResult(await telegramSendPhoto(args || {}));
  if (name === "telegram_send_document") return textResult(await telegramSendDocument(args || {}));
  if (name === "telegram_wait_reply") return textResult(await telegramWaitReply(args || {}));
  if (name === "telegram_ask") return textResult(await telegramAsk(args || {}));
  if (name === "telegram_inbox_read") return textResult(await telegramInboxRead(args || {}));
  if (name === "telegram_monitor_status") return textResult(await telegramMonitorStatus());
  if (name === "telegram_relay_status") {
    startTelegramMonitor();
    startTelegramRelay();
    return textResult(await telegramRelayStatus());
  }
  if (name === "telegram_approval_request") return textResult(await telegramApprovalRequest(args || {}));
  if (name === "telegram_bridge_health") return textResult(await healthCheck(args || {}));
  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const params = message.params || {};
    try {
      return await callTool(params.name, params.arguments || {});
    } catch (error) {
      if (error && error.code === -32601) throw error;
      return textResult(sanitize(error && error.message || "Tool error"), true);
    }
  }
  throw Object.assign(new Error(`method not found: ${message.method}`), { code: -32601 });
}

// stdout carries the JSON-RPC framing, so diagnostics go to stderr only. The
// bridge runs a background poll loop for the life of the process; letting a
// stray async failure terminate it would drop an in-flight tool call with no
// error response.
function installProcessGuards() {
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`${SERVER_NAME}: unhandled rejection: ${sanitize(reason && reason.stack || String(reason))}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`${SERVER_NAME}: uncaught exception: ${sanitize(error && error.stack || String(error))}\n`);
  });
}

function main() {
  installProcessGuards();
  maybeInstallPermissionHook();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      respondError(null, -32700, "Parse error", error.message);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    try {
      respond(message.id, await handleMessage(message));
    } catch (error) {
      respondError(message.id, Number.isInteger(error.code) ? error.code : -32000, sanitize(error.message || "Tool error"));
    }
  });

  startTelegramMonitor();

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

module.exports = {
  main,
  handleMessage,
  tools
};
