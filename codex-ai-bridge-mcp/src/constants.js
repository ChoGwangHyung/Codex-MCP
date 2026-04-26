"use strict";

const SERVER_NAME = "codex-ai-bridge-mcp";
const SERVER_VERSION = "1.0.0";
const MIN_TASK_TIMEOUT_MS = 10000;
const MIN_HEALTH_TIMEOUT_MS = 1000;
const MAX_HEALTH_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 900000;
const DEFAULT_TIMEOUT_MS = parseDefaultTimeout(process.env.CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS, 180000);
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

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  MIN_TASK_TIMEOUT_MS,
  MIN_HEALTH_TIMEOUT_MS,
  MAX_HEALTH_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  PROMPT_ARG,
  DEFAULT_ROLE,
  ROLES,
  POLICIES,
  EFFORTS,
  MODEL_RE
};
