"use strict";

const path = require("node:path");
const {
  DEFAULT_ROLE,
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  EFFORTS,
  MAX_SYNC_BUDGET_MS,
  MAX_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  MODEL_RE,
  POLICIES,
  ROLES
} = require("./constants.js");

const repoRoot = path.resolve(process.env.CODEX_AI_BRIDGE_ROOT || process.cwd());

function normalizeTimeout(value, fallback, minimum = MIN_TASK_TIMEOUT_MS, maximum = MAX_TIMEOUT_MS) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("timeoutMs is outside the supported range");
  }
  return parsed;
}

function normalizeSyncBudget(value, timeoutMs, background) {
  if (background) return -1;
  const fallback = timeoutMs > 0 ? Math.min(DEFAULT_SYNC_BUDGET_MS, timeoutMs) : DEFAULT_SYNC_BUDGET_MS;
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SYNC_BUDGET_MS) {
    throw new Error("syncBudgetMs is outside the supported range");
  }
  if (parsed === 0) return 0;
  return timeoutMs > 0 ? Math.min(parsed, timeoutMs) : parsed;
}

function resolveCwd(cwd) {
  if (!cwd) return repoRoot;
  const resolved = path.resolve(repoRoot, cwd);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`cwd must stay under repository root: ${repoRoot}`);
  }
  return resolved;
}

function validateModel(model) {
  if (model === undefined || model === null || model === "") return undefined;
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    throw new Error("model contains unsupported characters");
  }
  return model;
}

function validateEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return undefined;
  if (typeof effort !== "string" || !EFFORTS.has(effort)) {
    throw new Error("effort must be one of: low, medium, high, xhigh, max");
  }
  return effort;
}

function validateTaskArgs(args) {
  if (!args || typeof args !== "object") throw new Error("arguments object is required");
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required");
  const policy = POLICIES.has(args.policy) ? args.policy : "advisory";
  if (policy === "agentic" && process.env.CODEX_AI_BRIDGE_ALLOW_AGENTIC !== "1") {
    throw new Error("agentic policy is disabled. Set CODEX_AI_BRIDGE_ALLOW_AGENTIC=1 to enable it explicitly.");
  }
  const timeoutMs = normalizeTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS);
  const background = args.background === true;
  return {
    ...args,
    prompt: args.prompt.trim(),
    role: ROLES.has(args.role) ? args.role : DEFAULT_ROLE,
    policy,
    cwd: resolveCwd(args.cwd),
    model: validateModel(args.model),
    effort: validateEffort(args.effort),
    timeoutMs,
    background,
    syncBudgetMs: normalizeSyncBudget(args.syncBudgetMs, timeoutMs, background)
  };
}

function envJsonArray(name) {
  const raw = process.env[name];
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

module.exports = {
  repoRoot,
  normalizeTimeout,
  normalizeSyncBudget,
  resolveCwd,
  validateModel,
  validateEffort,
  validateTaskArgs,
  envJsonArray
};
