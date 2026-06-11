"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_HEALTH_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  PROMPT_ARG
} = require("./constants.js");
const {
  envJsonArray,
  normalizeTimeout,
  repoRoot,
  validateEffort,
  validateMaxTurns,
  validateModel,
  validateTaskArgs
} = require("./config.js");
const { buildPrompt } = require("./prompt.js");
const {
  formatJobPending,
  formatJobStatus,
  markJobChecked,
  startJob,
  waitForJob
} = require("./jobs.js");
const { withProviderLock } = require("./lock.js");
const { runCommand } = require("./runner.js");
const { sanitize } = require("./util.js");

function providerCommand(provider, args) {
  if (provider === "claude") {
    const model = validateModel(args.model || process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL);
    const effort = validateEffort(args.effort || process.env.CODEX_AI_BRIDGE_CLAUDE_EFFORT);
    const mode = args.policy === "agentic"
      ? (process.env.CODEX_AI_BRIDGE_CLAUDE_PERMISSION_MODE || "default")
      : "plan";
    const maxTurns = resolveClaudeMaxTurns(args);
    const commandArgs = [
      "-p",
      PROMPT_ARG,
      "--output-format",
      "text",
      "--permission-mode",
      mode,
      "--max-turns",
      String(maxTurns)
    ];
    if (args.policy !== "agentic") {
      commandArgs.push(
        "--disallowedTools", "Edit",
        "--disallowedTools", "Write",
        "--disallowedTools", "NotebookEdit",
        "--disallowedTools", "Bash"
      );
    }
    if (model) commandArgs.push("--model", model);
    if (effort) commandArgs.push("--effort", effort);
    return {
      command: process.env.CLAUDE_COMMAND || process.env.CODEX_AI_BRIDGE_CLAUDE_COMMAND || "claude",
      args: commandArgs.concat(envJsonArray("CODEX_AI_BRIDGE_CLAUDE_ARGS_JSON"))
    };
  }

  if (provider === "gemini") {
    const model = validateModel(args.model || process.env.CODEX_AI_BRIDGE_GEMINI_MODEL);
    const approvalMode = args.policy === "agentic"
      ? (process.env.CODEX_AI_BRIDGE_GEMINI_APPROVAL_MODE || "default")
      : "plan";
    const commandArgs = ["-p", PROMPT_ARG, `--approval-mode=${approvalMode}`, "--output-format", "text"];
    if (process.env.CODEX_AI_BRIDGE_GEMINI_SANDBOX === "1") {
      commandArgs.push("--sandbox");
    }
    if (model) commandArgs.push("--model", model);
    return {
      command: process.env.GEMINI_COMMAND || process.env.CODEX_AI_BRIDGE_GEMINI_COMMAND || "gemini",
      args: commandArgs.concat(envJsonArray("CODEX_AI_BRIDGE_GEMINI_ARGS_JSON"))
    };
  }

  if (provider === "antigravity") {
    const model = validateModel(args.model || process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL);
    const logFile = antigravityLogFile();
    const capture = antigravityCapture();
    const commandArgs = ["--log-file", logFile, "-p", "-", "--print-timeout", antigravityPrintTimeout(args)];
    if (antigravitySandboxEnabled(args)) {
      commandArgs.push("--sandbox");
    }
    if (args.policy === "agentic" && process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_DANGEROUS_SKIP_PERMISSIONS === "1") {
      commandArgs.push("--dangerously-skip-permissions");
    }
    if (model) commandArgs.push("--model", model);
    return {
      command: process.env.AGY_COMMAND || process.env.ANTIGRAVITY_COMMAND || process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_COMMAND || "agy",
      args: commandArgs.concat(envJsonArray("CODEX_AI_BRIDGE_ANTIGRAVITY_ARGS_JSON")),
      logFile,
      capture,
      emptyOutputIsFailure: true
    };
  }

  throw new Error(`unsupported provider: ${provider}`);
}

function antigravityPrintTimeout(args) {
  const configured = process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_PRINT_TIMEOUT;
  if (configured) return configured;
  if (args.timeoutMs > 0) return `${Math.max(1, Math.ceil(args.timeoutMs / 1000))}s`;
  return "15m";
}

function antigravitySandboxEnabled(args) {
  const configured = process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_SANDBOX;
  if (configured === "1") return true;
  if (configured === "0") return false;
  return args.policy !== "agentic";
}

function antigravityLogFile() {
  return path.join(os.tmpdir(), `codex-ai-bridge-antigravity-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.log`);
}

function antigravityCapture() {
  const id = `${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
  return {
    begin: `CODEX_AI_BRIDGE_RESULT_${id}_BEGIN`,
    end: `CODEX_AI_BRIDGE_RESULT_${id}_END`
  };
}

async function askProvider(provider, rawArgs, context = {}) {
  if (provider !== "claude" && rawArgs && Object.prototype.hasOwnProperty.call(rawArgs, "effort")) {
    throw new Error("effort is supported only for claude_task.");
  }
  const args = validateTaskArgs(rawArgs, { provider });
  const prompt = buildPrompt(args);
  const command = providerCommand(provider, args);
  const job = startJob(provider, args, (runningJob) => runProvider(provider, args, prompt, command, runningJob));
  if (args.background) return formatJobPending(job, "started in background");
  const completed = await waitForJob(job, args.syncBudgetMs, {
    onProgress: (runningJob) => reportProgress(context, runningJob)
  });
  if (!completed) return formatJobPending(job, `still running after ${args.syncBudgetMs}ms`);
  return formatJobStatus(job.jobId);
}

function reportProgress(context, job) {
  if (!context || context.progressToken === undefined || context.progressToken === null || typeof context.notify !== "function") return;
  context.notify("notifications/progress", {
    progressToken: context.progressToken,
    progress: Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000),
    message: `${job.provider} still running after ${Date.now() - Date.parse(job.startedAt)}ms`
  });
}

async function runProvider(provider, args, prompt, command, job) {
  const providerPrompt = command.capture ? wrapCapturedPrompt(prompt, command.capture) : prompt;
  const result = await withProviderLock(provider, args.timeoutMs, () => runCommand(command.command, command.args, {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    input: providerPrompt,
    onStart: (details) => markJobChecked(job, details)
  }), { scope: args.cwd });
  const stdoutOutput = sanitize(unwrapCapturedOutput(result.stdout, command.capture));
  const recoveredOutput = !stdoutOutput && command.capture
    ? sanitize(recoverCapturedAntigravityOutput(command))
    : "";
  const output = stdoutOutput || recoveredOutput;
  if (result.ok && (!command.emptyOutputIsFailure || output)) {
    cleanupProviderCommand(command);
    return `${provider} result:\n${output || "(no output)"}`;
  }
  const failureResult = result.ok && command.emptyOutputIsFailure
    ? { ...result, ok: false, error: "completed without stdout" }
    : result;
  const failure = formatProviderFailure(provider, args, failureResult, command);
  cleanupProviderCommand(command);
  return failure;
}

function formatProviderFailure(provider, args, result, command) {
  const reason = result.timedOut
    ? `hard timeout after ${args.timeoutMs}ms`
    : result.error || `exited with code ${result.exitCode}`;
  const stdout = tailOutput(result.stdout);
  const stderr = tailOutput(result.stderr);
  const providerLog = tailOutput(readProviderLog(command && command.logFile));
  return [
    `${provider} failed: ${reason}`,
    `cwd: ${sanitize(args.cwd)}`,
    command ? `argv: ${formatArgv(command)}` : null,
    `timedOut: ${Boolean(result.timedOut)}`,
    `pid: ${result.pid || "unknown"}`,
    `elapsedMs: ${Number.isInteger(result.elapsedMs) ? result.elapsedMs : "unknown"}`,
    Number.isInteger(result.exitCode) ? `exitCode: ${result.exitCode}` : null,
    stdout ? `stdout partial:\n${stdout}` : "stdout partial: (empty)",
    stderr ? `stderr partial:\n${stderr}` : "stderr partial: (empty)",
    providerLog ? `provider log partial:\n${providerLog}` : null
  ].filter(Boolean).join("\n");
}

function wrapCapturedPrompt(prompt, capture) {
  return [
    prompt,
    "",
    "Antigravity print-mode constraint:",
    "Do not use tools, shell commands, grep/search, workspace file reads, browser actions, MCP calls, or subagents.",
    "Answer only from the task and context supplied in this prompt.",
    "",
    "Capture requirement:",
    `Start your final answer with this exact line: ${capture.begin}`,
    `End your final answer with this exact line: ${capture.end}`,
    "Do not include either capture line anywhere else."
  ].join("\n");
}

function unwrapCapturedOutput(text, capture) {
  if (!capture) return text || "";
  const clean = text || "";
  const matches = [];
  let searchIndex = 0;
  while (searchIndex < clean.length) {
    const beginIndex = clean.indexOf(capture.begin, searchIndex);
    if (beginIndex < 0) break;
    const contentStart = beginIndex + capture.begin.length;
    const endIndex = clean.indexOf(capture.end, contentStart);
    if (endIndex < 0) break;
    const content = clean.slice(contentStart, endIndex).trim();
    if (isCapturedProviderAnswer(content)) matches.push(content);
    searchIndex = endIndex + capture.end.length;
  }
  return matches.length ? matches[matches.length - 1] : "";
}

function isCapturedProviderAnswer(content) {
  if (!content) return false;
  if (/^(start|end) your final answer with this exact line:?/i.test(content)) return false;
  if (/capture requirement/i.test(content)) return false;
  return true;
}

function recoverCapturedAntigravityOutput(command) {
  const log = readProviderLog(command && command.logFile);
  const conversationId = latestAntigravityConversationId(log);
  if (!conversationId || !command || !command.capture) return "";
  const dbPath = path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations", `${conversationId}.db`);
  let text = "";
  try {
    text = fs.readFileSync(dbPath).toString("utf8");
  } catch {
    return "";
  }
  return unwrapCapturedOutput(text, command.capture);
}

function latestAntigravityConversationId(log) {
  const text = log || "";
  let latest = "";
  for (const match of text.matchAll(/(?:conversation=|Created conversation )([0-9a-f-]{36})/gi)) {
    latest = match[1];
  }
  return latest;
}

function readProviderLog(logFile) {
  if (!logFile) return "";
  try {
    return fs.readFileSync(logFile, "utf8");
  } catch {
    return "";
  }
}

function cleanupProviderCommand(command) {
  if (!command || !command.logFile) return;
  const logFile = path.resolve(command.logFile);
  const tempDir = path.resolve(os.tmpdir());
  if (!logFile.startsWith(`${tempDir}${path.sep}`)) return;
  try {
    fs.rmSync(logFile, { force: true });
  } catch {
    // Best-effort cleanup for provider logs.
  }
}

function resolveClaudeMaxTurns(args) {
  const configured = args.maxTurns !== undefined && args.maxTurns !== null && args.maxTurns !== ""
    ? args.maxTurns
    : process.env.CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS;
  return validateMaxTurns(configured !== undefined && configured !== null && configured !== ""
    ? configured
    : (args.policy === "agentic" ? 8 : 3));
}

function formatArgv(command) {
  return [command.command, ...command.args].map(formatArg).join(" ");
}

function formatArg(value) {
  const clean = sanitize(String(value));
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(clean)) return clean;
  return JSON.stringify(clean);
}

function tailOutput(text) {
  const clean = sanitize(text);
  if (!clean) return "";
  return clean.slice(-4000);
}

function jobStatus(rawArgs) {
  if (!rawArgs || typeof rawArgs.jobId !== "string" || !rawArgs.jobId.trim()) {
    throw new Error("jobId is required");
  }
  return formatJobStatus(rawArgs.jobId.trim());
}

async function healthCheck(rawArgs) {
  const timeoutMs = normalizeTimeout(rawArgs && rawArgs.timeoutMs, 10000, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
  const checks = await Promise.all(["claude", "gemini", "antigravity"].map(async (provider) => {
    const command = providerCommand(provider, { policy: "advisory" });
    const result = await runCommand(command.command, ["--version"], { cwd: repoRoot, timeoutMs, input: "" });
    const output = sanitize(result.stdout || result.stderr).split(/\r?\n/)[0];
    return `${provider}: ${result.ok ? "ok" : "unavailable"}${output ? ` (${output})` : ""}`;
  }));
  return checks.join("\n");
}

module.exports = {
  askProvider,
  healthCheck,
  jobStatus
};
