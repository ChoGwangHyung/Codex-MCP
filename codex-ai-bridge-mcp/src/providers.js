"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FAILURE_TAIL_CHARS,
  MAX_HEALTH_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  PROGRESS_INTERVAL_MS,
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
  getJob,
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
    const effort = validateEffort(args.effort || process.env.CODEX_AI_BRIDGE_CLAUDE_EFFORT, "claude");
    const mode = args.policy === "agentic"
      ? claudePermissionMode()
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
    const effort = validateEffort(
      args.effort || process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT,
      "antigravity"
    );
    const logFile = antigravityLogFile();
    const capture = antigravityCapture();
    const commandArgs = ["--log-file", logFile, "--print-timeout", antigravityPrintTimeout(args)];
    if (args.policy !== "agentic") {
      commandArgs.push("--mode", "plan");
    }
    if (antigravitySandboxEnabled(args)) {
      commandArgs.push("--sandbox");
    }
    if (args.policy === "agentic" && process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_DANGEROUS_SKIP_PERMISSIONS === "1") {
      commandArgs.push("--dangerously-skip-permissions");
    }
    if (model) commandArgs.push("--model", model);
    if (effort) commandArgs.push("--effort", effort);
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

async function askProviderOutcome(provider, rawArgs, context = {}) {
  const args = validateTaskArgs(rawArgs, { provider });
  const prompt = buildPrompt(args);
  const command = providerCommand(provider, args);
  const job = startJob(provider, args, (runningJob) => runProvider(provider, args, prompt, command, runningJob));
  if (args.background) {
    return { text: formatJobPending(job, "started in background"), isError: false };
  }
  const reportsProgress = Boolean(context) &&
    context.progressToken !== undefined &&
    context.progressToken !== null &&
    typeof context.notify === "function";
  const completed = await waitForJob(job, args.syncBudgetMs, {
    // Without this the wait slice is the job heartbeat (5 minutes by default),
    // so a client watching notifications/progress saw nothing for the whole
    // foreground budget.
    progressIntervalMs: reportsProgress ? PROGRESS_INTERVAL_MS : 0,
    onProgress: (runningJob) => reportProgress(context, runningJob)
  });
  if (!completed) {
    return {
      text: formatJobPending(job, `still running after ${args.syncBudgetMs}ms`),
      isError: false
    };
  }
  return {
    text: formatJobStatus(job.jobId),
    isError: job.status !== "completed"
  };
}

async function askProvider(provider, rawArgs, context = {}) {
  return (await askProviderOutcome(provider, rawArgs, context)).text;
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
  }), { scope: repoRoot() });
  const stdoutOutput = sanitize(unwrapCapturedOutput(result.stdout, command.capture));
  const recoveredOutput = !stdoutOutput && command.capture
    ? sanitize(recoverCapturedAntigravityOutput(command))
    : "";
  const output = stdoutOutput || recoveredOutput;
  if (result.ok && (!command.emptyOutputIsFailure || output)) {
    cleanupProviderCommand(command);
    return {
      ok: true,
      status: "completed",
      text: `${provider} result:\n${clampResult(output, args.maxOutputChars) || "(no output)"}`,
      pid: result.pid,
      elapsedMs: result.elapsedMs
    };
  }
  const failureResult = result.ok && command.emptyOutputIsFailure
    ? { ...result, ok: false, error: "completed without stdout" }
    : result;
  const failure = formatProviderFailure(provider, args, failureResult, command);
  cleanupProviderCommand(command);
  return {
    ok: false,
    status: failureResult.timedOut ? "timeout" : "failed",
    failureKind: failureResult.timedOut ? "hard_timeout" : "provider_failure",
    text: failure,
    pid: failureResult.pid,
    elapsedMs: failureResult.elapsedMs
  };
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
  return redactArgv([command.command, ...command.args]).map(formatArg).join(" ");
}

function redactArgv(argv) {
  const sensitive = /^(--?(?:api[-_]?key|auth[-_]?token|token|password|secret|credential))(?:=(.*))?$/i;
  let redactNext = false;
  return argv.map((value) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    const text = String(value);
    const match = sensitive.exec(text);
    if (!match) return text;
    if (text.includes("=")) return `${text.slice(0, text.indexOf("=") + 1)}<redacted>`;
    redactNext = true;
    return text;
  });
}

function formatArg(value) {
  const clean = sanitize(String(value));
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(clean)) return clean;
  return JSON.stringify(clean);
}

function tailOutput(text) {
  const clean = sanitize(text);
  if (!clean) return "";
  if (clean.length <= FAILURE_TAIL_CHARS) return clean;
  return clampTailWithNotice(clean, FAILURE_TAIL_CHARS);
}

// Provider answers usually open with a summary and close with the conclusion,
// so an over-budget result keeps both ends instead of a single tail.
function clampResult(text, maxChars) {
  const clean = String(text || "");
  const limit = Number(maxChars);
  if (!Number.isInteger(limit) || limit <= 0 || clean.length <= limit) return clean;
  let retainedChars = limit;
  let notice = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedChars = Math.max(0, clean.length - retainedChars);
    notice = `\n[... ${omittedChars} of ${clean.length} chars omitted; raise maxOutputChars for the full text ...]\n`;
    retainedChars = Math.max(0, limit - notice.length);
  }
  if (retainedChars === 0) return clean.slice(0, limit);
  const headChars = Math.floor(retainedChars * 0.6);
  const tailChars = retainedChars - headChars;
  return [
    clean.slice(0, headChars),
    notice,
    clean.slice(-tailChars)
  ].join("");
}

function clampTailWithNotice(text, limit) {
  let retainedChars = limit;
  let notice = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    notice = `[trimmed ${Math.max(0, text.length - retainedChars)} of ${text.length} chars]\n`;
    retainedChars = Math.max(0, limit - notice.length);
  }
  if (retainedChars === 0) return text.slice(-limit);
  return `${notice}${text.slice(-retainedChars)}`;
}

function jobStatusOutcome(rawArgs) {
  if (!rawArgs || typeof rawArgs.jobId !== "string" || !rawArgs.jobId.trim()) {
    throw new Error("jobId is required");
  }
  const job = getJob(rawArgs.jobId.trim());
  if (!job) {
    return {
      text: `job not found: ${sanitize(rawArgs.jobId.trim())}`,
      isError: true
    };
  }
  return {
    text: formatJobStatus(job.jobId),
    isError: job.status !== "running" && job.status !== "completed"
  };
}

function claudePermissionMode() {
  const mode = String(process.env.CODEX_AI_BRIDGE_CLAUDE_PERMISSION_MODE || "acceptEdits");
  const supported = new Set(["manual", "auto", "acceptEdits", "dontAsk", "plan", "bypassPermissions"]);
  if (!supported.has(mode)) {
    throw new Error(`Unsupported Claude permission mode: ${mode}`);
  }
  return mode;
}

async function healthCheck(rawArgs) {
  const timeoutMs = normalizeTimeout(rawArgs && rawArgs.timeoutMs, 10000, MIN_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS);
  const checks = await Promise.all(["claude", "gemini", "antigravity"].map(async (provider) => {
    // Each provider reports on its own line. A bad env override for one of them
    // used to reject the whole Promise.all and hide the other two.
    try {
      const command = providerCommand(provider, { policy: "advisory" });
      const result = await runCommand(command.command, ["--version"], { cwd: repoRoot(), timeoutMs, input: "" });
      const output = sanitize(result.stdout || result.stderr).split(/\r?\n/)[0];
      return `${provider}: ${result.ok ? "ok" : "unavailable"}${output ? ` (${output})` : ""}`;
    } catch (error) {
      return `${provider}: misconfigured (${sanitize(error && error.message || "unknown error")})`;
    }
  }));
  return checks.join("\n");
}

module.exports = {
  askProvider,
  askProviderOutcome,
  healthCheck,
  jobStatusOutcome,
  _test: {
    clampResult,
    tailOutput
  }
};
