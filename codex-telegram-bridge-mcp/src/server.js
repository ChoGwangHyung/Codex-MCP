"use strict";

const readline = require("node:readline");
const {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_TELEGRAM_TIMEOUT_MS,
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
  setRelayHooks,
  startTelegramMonitor,
  telegramApprovalRequest,
  telegramAsk,
  telegramInboxRead,
  telegramMonitorStatus,
  telegramSend,
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
  }, ["chatId", "text"]),
  tool("telegram_wait_reply", "Wait for the next Telegram message from an allowlisted chat.", {
    chatId: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_TELEGRAM_TIMEOUT_MS },
    ignoreExisting: {
      type: "boolean",
      default: true,
      description: "When true, consume existing updates before waiting for the next message."
    }
  }, ["chatId"]),
  tool("telegram_ask", "Send a Telegram question and wait for one reply from the same allowlisted chat.", {
    chatId: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 5000, maximum: 900000, default: DEFAULT_TELEGRAM_TIMEOUT_MS }
  }, ["chatId", "text"]),
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

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required
    }
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

async function healthCheck() {
  return [
    `telegram: ${telegramEnabled() ? "configured" : "disabled or incomplete"}`,
    `config_dir: ${telegramConfigDir()}`,
    `env_file: ${telegramEnvPath()}`,
    `access_file: ${telegramAccessPath()}`,
    `token: ${process.env.TELEGRAM_BOT_TOKEN ? maskToken(process.env.TELEGRAM_BOT_TOKEN) : "not set"}`,
    `enabled: ${bridgeEnabled() ? "yes" : "no"}`,
    `allowed_chats: ${allowedChatIds().size}`,
    `codex_relay: ${relayEnabled() ? "enabled" : "disabled"}`
  ].join("\n");
}

async function callTool(name, args) {
  if (name === "telegram_send") return textResult(await telegramSend(args || {}));
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
  if (name === "telegram_bridge_health") return textResult(await healthCheck());
  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: (message.params && message.params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const params = message.params || {};
    return callTool(params.name, params.arguments || {});
  }
  throw Object.assign(new Error(`method not found: ${message.method}`), { code: -32601 });
}

function main() {
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
