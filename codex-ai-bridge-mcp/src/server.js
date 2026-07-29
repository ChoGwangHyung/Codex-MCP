"use strict";

const readline = require("node:readline");
const {
  ANTIGRAVITY_EFFORTS,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_ROLE,
  DEFAULT_TIMEOUT_MS,
  CLAUDE_EFFORTS,
  MAX_PROVIDER_MAX_TURNS,
  MAX_HEALTH_TIMEOUT_MS,
  MAX_RESULT_CHARS_LIMIT,
  MAX_SYNC_BUDGET_MS,
  MAX_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  POLICIES,
  PRESETS,
  PROTOCOL_VERSION,
  ROLES,
  SERVER_NAME,
  SERVER_VERSION
} = require("./constants.js");
const { askProviderOutcome, healthCheck, jobStatusOutcome } = require("./providers.js");
const { terminateAllChildren } = require("./runner.js");
const { sanitize } = require("./util.js");

const tools = [
  tool("claude_task", "Ask Claude Code for advisory, planning, review, QA, or optionally agentic work.", taskSchema({ includeEffort: true, includeMaxTurns: true })),
  tool("gemini_task", "Ask Gemini CLI for advisory, planning, review, QA, or optionally agentic work.", taskSchema({ includeMaxTurns: true })),
  tool("antigravity_task", "Ask Antigravity CLI for advisory, planning, review, QA, or optionally agentic work.", taskSchema({ includeAntigravityEffort: true, includeMaxTurns: true })),
  tool("cross_review", "Ask Claude, Gemini, or Antigravity in parallel and return the selected responses.", {
    ...taskSchema({ includeMaxTurns: true }).properties,
    providers: {
      type: "array",
      items: { type: "string", enum: ["claude", "gemini", "antigravity"] },
      minItems: 1,
      uniqueItems: true,
      default: ["claude", "gemini"]
    },
    claudeEffort: { type: "string", enum: [...CLAUDE_EFFORTS], description: "Claude-only effort override." },
    antigravityEffort: { type: "string", enum: [...ANTIGRAVITY_EFFORTS], description: "Antigravity-only effort override." }
  }),
  tool("ai_bridge_job", "Poll a background AI bridge job returned by claude_task, gemini_task, antigravity_task, or cross_review.", {
    jobId: { type: "string", minLength: 1 }
  }, ["jobId"]),
  tool("ai_bridge_health", "Check whether Claude, Gemini, and Antigravity CLIs are available.", {
    timeoutMs: { type: "integer", minimum: MIN_HEALTH_TIMEOUT_MS, maximum: MAX_HEALTH_TIMEOUT_MS, default: 10000 }
  }, [])
];

function taskSchema(options = {}) {
  const properties = {
    prompt: { type: "string", minLength: 1 },
    context: { type: "string" },
    preset: {
      type: "string",
      enum: [...PRESETS],
      description: "quick: 2min timeout, 1min budget, low effort. review: 15min timeout, 2min budget, high effort."
    },
    role: { type: "string", enum: [...ROLES], default: DEFAULT_ROLE },
    policy: {
      type: "string",
      enum: [...POLICIES],
      default: "advisory",
      description: "agentic requires CODEX_AI_BRIDGE_ALLOW_AGENTIC=1."
    },
    cwd: { type: "string", description: "Directory under CODEX_AI_BRIDGE_ROOT." },
    model: { type: "string", description: "Provider model override." },
    timeoutMs: {
      type: "integer",
      minimum: MIN_TASK_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      default: DEFAULT_TIMEOUT_MS,
      description: "Hard provider timeout; 0 disables it."
    },
    background: {
      type: "boolean",
      default: false,
      description: "Return a job id immediately and keep running."
    },
    syncBudgetMs: {
      type: "integer",
      minimum: 0,
      maximum: MAX_SYNC_BUDGET_MS,
      default: DEFAULT_SYNC_BUDGET_MS,
      description: "Foreground wait before returning a job id."
    },
    maxOutputChars: {
      type: "integer",
      minimum: 0,
      maximum: MAX_RESULT_CHARS_LIMIT,
      default: DEFAULT_MAX_RESULT_CHARS,
      description: "Result character budget; over-budget output keeps head and tail. 0 disables trimming."
    }
  };
  if (options.includeEffort) {
    properties.effort = { type: "string", enum: [...CLAUDE_EFFORTS] };
  }
  if (options.includeAntigravityEffort) {
    properties.effort = { type: "string", enum: [...ANTIGRAVITY_EFFORTS] };
  }
  if (options.includeMaxTurns) {
    properties.maxTurns = {
      type: "integer",
      minimum: 1,
      maximum: MAX_PROVIDER_MAX_TURNS,
      description: "Claude only; Gemini and Antigravity CLIs expose no equivalent."
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

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args, context = {}) {
  if (name === "claude_task") return outcomeResult(await askProviderOutcome("claude", args, context));
  if (name === "gemini_task") return outcomeResult(await askProviderOutcome("gemini", args, context));
  if (name === "antigravity_task") return outcomeResult(await askProviderOutcome("antigravity", args, context));
  if (name === "cross_review") {
    if (args && Object.prototype.hasOwnProperty.call(args, "effort")) {
      throw new Error("cross_review does not support effort. Use claude_task for Claude effort control.");
    }
    const providers = Array.isArray(args && args.providers) && args.providers.length ? args.providers : ["claude", "gemini"];
    const unique = [...new Set(providers)].filter((provider) => provider === "claude" || provider === "gemini" || provider === "antigravity");
    if (unique.length === 0) throw new Error("providers must include claude, gemini, or antigravity");
    const results = await Promise.all(unique.map((provider) => {
      const providerArgs = { ...args };
      delete providerArgs.providers;
      delete providerArgs.claudeEffort;
      delete providerArgs.antigravityEffort;
      if (provider === "claude" && args.claudeEffort) providerArgs.effort = args.claudeEffort;
      if (provider === "antigravity" && args.antigravityEffort) providerArgs.effort = args.antigravityEffort;
      return askProviderOutcome(provider, providerArgs, context);
    }));
    return textResult(
      results.map((result) => result.text).join("\n\n---\n\n"),
      results.some((result) => result.isError)
    );
  }
  if (name === "ai_bridge_job") return outcomeResult(jobStatusOutcome(args || {}));
  if (name === "ai_bridge_health") return textResult(await healthCheck(args || {}));
  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32601 });
}

function outcomeResult(outcome) {
  return textResult(outcome.text, Boolean(outcome.isError));
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
    const meta = params._meta || {};
    try {
      return await callTool(params.name, params.arguments || {}, {
        progressToken: meta.progressToken,
        notify
      });
    } catch (error) {
      if (error && error.code === -32601) throw error;
      return textResult(sanitize(error && error.message || "Tool error"), true);
    }
  }
  throw Object.assign(new Error(`method not found: ${message.method}`), { code: -32601 });
}

// stdout carries the JSON-RPC framing, so diagnostics go to stderr only.
// A stdio MCP server that exits on a stray async failure leaves the client with
// a dead pipe and no error response, which is strictly worse than staying up
// with the fault recorded.
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    await terminateAllChildren();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = {
  tools,
  handleMessage,
  main
};
