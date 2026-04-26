"use strict";

const readline = require("node:readline");
const {
  DEFAULT_ROLE,
  DEFAULT_TIMEOUT_MS,
  EFFORTS,
  MAX_HEALTH_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  POLICIES,
  ROLES,
  SERVER_NAME,
  SERVER_VERSION
} = require("./constants.js");
const { askProvider, healthCheck } = require("./providers.js");
const { sanitize } = require("./util.js");

const tools = [
  tool("claude_task", "Ask Claude Code for advisory, planning, review, QA, or optionally agentic work.", taskSchema({ includeEffort: true })),
  tool("gemini_task", "Ask Gemini CLI for advisory, planning, review, QA, or optionally agentic work.", taskSchema()),
  tool("cross_review", "Ask Claude and Gemini in parallel and return both responses.", {
    ...taskSchema().properties,
    providers: {
      type: "array",
      items: { type: "string", enum: ["claude", "gemini"] },
      minItems: 1,
      uniqueItems: true,
      default: ["claude", "gemini"]
    }
  }),
  tool("ai_bridge_health", "Check whether Claude and Gemini CLIs are available.", {
    timeoutMs: { type: "integer", minimum: MIN_HEALTH_TIMEOUT_MS, maximum: MAX_HEALTH_TIMEOUT_MS, default: 10000 }
  }, [])
];

function taskSchema(options = {}) {
  const properties = {
    prompt: { type: "string", minLength: 1 },
    context: { type: "string" },
    role: { type: "string", enum: [...ROLES], default: DEFAULT_ROLE },
    policy: {
      type: "string",
      enum: [...POLICIES],
      default: "advisory",
      description: "advisory is default. agentic requires CODEX_AI_BRIDGE_ALLOW_AGENTIC=1."
    },
    cwd: { type: "string", description: "Working directory under CODEX_AI_BRIDGE_ROOT." },
    model: { type: "string" },
    timeoutMs: { type: "integer", minimum: MIN_TASK_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS }
  };
  if (options.includeEffort) {
    properties.effort = {
      type: "string",
      enum: [...EFFORTS],
      description: "Claude-only effort level."
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["prompt"]
  };
}

function tool(name, description, propertiesOrSchema, required = ["prompt"]) {
  const inputSchema = propertiesOrSchema.type === "object" && propertiesOrSchema.properties
    ? propertiesOrSchema
    : { type: "object", additionalProperties: false, properties: propertiesOrSchema, required };
  return { name, description, inputSchema };
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

async function callTool(name, args) {
  if (name === "claude_task") return textResult(await askProvider("claude", args));
  if (name === "gemini_task") return textResult(await askProvider("gemini", args));
  if (name === "cross_review") {
    if (args && Object.prototype.hasOwnProperty.call(args, "effort")) {
      throw new Error("cross_review does not support effort. Use claude_task for Claude effort control.");
    }
    const providers = Array.isArray(args && args.providers) && args.providers.length ? args.providers : ["claude", "gemini"];
    const unique = [...new Set(providers)].filter((provider) => provider === "claude" || provider === "gemini");
    if (unique.length === 0) throw new Error("providers must include claude or gemini");
    const results = await Promise.all(unique.map((provider) => askProvider(provider, args)));
    return textResult(results.join("\n\n---\n\n"));
  }
  if (name === "ai_bridge_health") return textResult(await healthCheck(args || {}));
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

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

module.exports = {
  tools,
  handleMessage,
  main
};
