"use strict";

const SERVER_NAME = "codex-ai-bridge-mcp";
const SERVER_VERSION = "1.0.0";
const MIN_TASK_TIMEOUT_MS = 0;
const MIN_HEALTH_TIMEOUT_MS = 1000;
const MAX_HEALTH_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 900000;
const MAX_SYNC_BUDGET_MS = 115000;
const DEFAULT_TIMEOUT_MS = parseDefaultTimeout(process.env.CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS, 0);
const DEFAULT_SYNC_BUDGET_MS = parseSyncBudget(process.env.CODEX_AI_BRIDGE_SYNC_BUDGET_MS, 100000);
const DEFAULT_JOB_CHECK_MS = parseJobCheckInterval(process.env.CODEX_AI_BRIDGE_JOB_CHECK_MS, 5 * 60 * 1000);
const MAX_OUTPUT_BYTES = 240000;
const PROMPT_ARG = "Use stdin as the complete task context. Follow the requested permission policy.";
const DEFAULT_ROLE = "reviewer";
const ROLES = new Set(["planner", "reviewer", "security", "qa", "architecture", "refactor", "implementer"]);
const POLICIES = new Set(["advisory", "workspace-read", "agentic"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;

function parseDefaultTimeout(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TASK_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) return fallback;
  return parsed;
}

function parseSyncBudget(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SYNC_BUDGET_MS) return fallback;
  return parsed;
}

function parseJobCheckInterval(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10000) return fallback;
  return parsed;
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  MIN_TASK_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  MAX_HEALTH_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_SYNC_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_JOB_CHECK_MS,
  MAX_OUTPUT_BYTES,
  PROMPT_ARG,
  DEFAULT_ROLE,
  ROLES,
  POLICIES,
  EFFORTS,
  MODEL_RE
};
