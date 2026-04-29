"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_ROLE,
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  EFFORTS,
  MAX_PROVIDER_MAX_TURNS,
  MAX_SYNC_BUDGET_MS,
  MAX_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  MODEL_RE,
  POLICIES,
  PRESETS,
  REVIEW_MAX_TURNS,
  REVIEW_SYNC_BUDGET_MS,
  REVIEW_TIMEOUT_MS,
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

function timingDefaults(args, options = {}) {
  const preset = validatePreset(args.preset);
  const reviewPreset = preset === "review";
  const timeoutFallback = reviewPreset ? REVIEW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const syncBudgetFallback = reviewPreset ? REVIEW_SYNC_BUDGET_MS : DEFAULT_SYNC_BUDGET_MS;
  const timeoutMs = normalizeTimeout(args.timeoutMs, timeoutFallback);
  const background = args.background === true;
  let syncBudgetMs = normalizeSyncBudgetWithFallback(args.syncBudgetMs, timeoutMs, background, syncBudgetFallback);
  const warnings = [];

  if (timeoutMs > 0 && syncBudgetMs > 0 && syncBudgetMs >= timeoutMs) {
    const adjusted = Math.max(0, timeoutMs - syncBudgetHeadroomMs(timeoutMs));
    warnings.push(`syncBudgetMs (${syncBudgetMs}) was adjusted to ${adjusted} because it must be lower than timeoutMs (${timeoutMs}) to leave time for background polling before the hard timeout.`);
    syncBudgetMs = adjusted;
  }

  return { preset, timeoutMs, background, syncBudgetMs, warnings, provider: options.provider };
}

function normalizeSyncBudgetWithFallback(value, timeoutMs, background, fallback) {
  if (background) return -1;
  const effectiveFallback = timeoutMs > 0 ? Math.min(fallback, timeoutMs) : fallback;
  if (value === undefined || value === null) return effectiveFallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SYNC_BUDGET_MS) {
    throw new Error("syncBudgetMs is outside the supported range");
  }
  if (parsed === 0) return 0;
  return timeoutMs > 0 ? Math.min(parsed, timeoutMs) : parsed;
}

function syncBudgetHeadroomMs(timeoutMs) {
  return Math.min(30000, Math.max(1000, Math.floor(timeoutMs * 0.1)));
}

function resolveCwd(cwd) {
  if (!cwd) return ensureDirectory(repoRoot, "CODEX_AI_BRIDGE_ROOT");
  const resolved = path.resolve(repoRoot, cwd);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`cwd must stay under repository root: ${repoRoot}`);
  }
  return ensureDirectory(resolved, "cwd");
}

function ensureDirectory(value, label) {
  try {
    if (fs.statSync(value).isDirectory()) return value;
  } catch {
    // Fall through to a clearer validation error.
  }
  throw new Error(`${label} must exist and be a directory: ${value}`);
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

function validateMaxTurns(maxTurns) {
  if (maxTurns === undefined || maxTurns === null || maxTurns === "") return undefined;
  const parsed = Number(maxTurns);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PROVIDER_MAX_TURNS) {
    throw new Error(`maxTurns must be an integer from 1 to ${MAX_PROVIDER_MAX_TURNS}`);
  }
  return parsed;
}

function validatePreset(preset) {
  if (preset === undefined || preset === null || preset === "") return undefined;
  if (typeof preset !== "string" || !PRESETS.has(preset)) {
    throw new Error("preset must be one of: review");
  }
  return preset;
}

function validateTaskArgs(args, options = {}) {
  if (!args || typeof args !== "object") throw new Error("arguments object is required");
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required");
  const policy = POLICIES.has(args.policy) ? args.policy : "advisory";
  if (policy === "agentic" && process.env.CODEX_AI_BRIDGE_ALLOW_AGENTIC !== "1") {
    throw new Error("agentic policy is disabled. Set CODEX_AI_BRIDGE_ALLOW_AGENTIC=1 to enable it explicitly.");
  }
  const timing = timingDefaults(args, options);
  const reviewPreset = timing.preset === "review";
  const reviewMaxTurns = reviewPreset && options.provider === "claude" ? REVIEW_MAX_TURNS : undefined;
  return {
    ...args,
    preset: timing.preset,
    prompt: args.prompt.trim(),
    role: ROLES.has(args.role) ? args.role : (reviewPreset ? "reviewer" : DEFAULT_ROLE),
    policy,
    cwd: resolveCwd(args.cwd),
    model: validateModel(args.model || (reviewPreset && options.provider === "claude" ? "opus" : undefined)),
    effort: validateEffort(args.effort || (reviewPreset && options.provider === "claude" ? "max" : undefined)),
    maxTurns: validateMaxTurns(args.maxTurns !== undefined && args.maxTurns !== null && args.maxTurns !== "" ? args.maxTurns : reviewMaxTurns),
    timeoutMs: timing.timeoutMs,
    background: timing.background,
    syncBudgetMs: timing.syncBudgetMs,
    warnings: timing.warnings
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
  normalizeSyncBudgetWithFallback,
  resolveCwd,
  validateModel,
  validateEffort,
  validateMaxTurns,
  validatePreset,
  validateTaskArgs,
  envJsonArray
};
