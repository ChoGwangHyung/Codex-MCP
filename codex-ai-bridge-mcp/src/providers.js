"use strict";

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
    const commandArgs = [
      "-p",
      PROMPT_ARG,
      "--output-format",
      "text",
      "--permission-mode",
      mode,
      "--max-turns",
      process.env.CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS || (args.policy === "agentic" ? "8" : "3")
    ];
    if (args.policy !== "agentic") {
      commandArgs.push(
        "--disallowedTools", "Edit",
        "--disallowedTools", "Write",
        "--disallowedTools", "MultiEdit",
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

  const approvalMode = args.policy === "agentic"
    ? (process.env.CODEX_AI_BRIDGE_GEMINI_APPROVAL_MODE || "default")
    : "plan";
  const commandArgs = ["-p", PROMPT_ARG, `--approval-mode=${approvalMode}`, "--output-format", "text"];
  if (process.env.CODEX_AI_BRIDGE_GEMINI_SANDBOX === "1") {
    commandArgs.push("--sandbox");
  }
  if (args.model) commandArgs.push("--model", args.model);
  return {
    command: process.env.GEMINI_COMMAND || process.env.CODEX_AI_BRIDGE_GEMINI_COMMAND || "gemini",
    args: commandArgs.concat(envJsonArray("CODEX_AI_BRIDGE_GEMINI_ARGS_JSON"))
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
  const result = await withProviderLock(provider, args.timeoutMs, () => runCommand(command.command, command.args, {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    input: prompt,
    onStart: (details) => markJobChecked(job, details)
  }), { scope: args.cwd });
  const output = sanitize(result.stdout);
  if (result.ok) return `${provider} result:\n${output || "(no output)"}`;
  return formatProviderFailure(provider, args, result);
}

function formatProviderFailure(provider, args, result) {
  const reason = result.timedOut
    ? `hard timeout after ${args.timeoutMs}ms`
    : result.error || `exited with code ${result.exitCode}`;
  const stdout = tailOutput(result.stdout);
  const stderr = tailOutput(result.stderr);
  return [
    `${provider} failed: ${reason}`,
    `timedOut: ${Boolean(result.timedOut)}`,
    `pid: ${result.pid || "unknown"}`,
    `elapsedMs: ${Number.isInteger(result.elapsedMs) ? result.elapsedMs : "unknown"}`,
    Number.isInteger(result.exitCode) ? `exitCode: ${result.exitCode}` : null,
    stdout ? `stdout partial:\n${stdout}` : "stdout partial: (empty)",
    stderr ? `stderr partial:\n${stderr}` : "stderr partial: (empty)"
  ].filter(Boolean).join("\n");
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
  const checks = await Promise.all(["claude", "gemini"].map(async (provider) => {
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
