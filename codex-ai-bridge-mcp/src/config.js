"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_ROLE,
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  ANTIGRAVITY_EFFORTS,
  CLAUDE_EFFORTS,
  MAX_PROVIDER_MAX_TURNS,
  MAX_RESULT_CHARS_LIMIT,
  MAX_SYNC_BUDGET_MS,
  MAX_TIMEOUT_MS,
  MIN_TASK_TIMEOUT_MS,
  MODEL_RE,
  POLICIES,
  PRESETS,
  QUICK_MAX_TURNS,
  QUICK_SYNC_BUDGET_MS,
  QUICK_TIMEOUT_MS,
  REVIEW_MAX_TURNS,
  REVIEW_SYNC_BUDGET_MS,
  REVIEW_TIMEOUT_MS,
  ROLES
} = require("./constants.js");

let cachedRepoRoot = "";

// Resolved on first use rather than at import time. An unusable
// CODEX_AI_BRIDGE_ROOT used to throw while the module graph was still loading,
// which killed the server before it could answer `initialize` and left the
// client with an unexplained startup failure. Deferring it turns the same
// misconfiguration into a readable tool error.
function repoRoot() {
  if (!cachedRepoRoot) {
    cachedRepoRoot = canonicalDirectory(
      path.resolve(process.env.CODEX_AI_BRIDGE_ROOT || process.cwd()),
      "CODEX_AI_BRIDGE_ROOT"
    );
  }
  return cachedRepoRoot;
}

function normalizeTimeout(value, fallback, minimum = MIN_TASK_TIMEOUT_MS, maximum = MAX_TIMEOUT_MS) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("timeoutMs is outside the supported range");
  }
  return parsed;
}

function timingDefaults(args, options = {}) {
  const preset = validatePreset(args.preset);
  const timeoutFallback = presetValue(preset, REVIEW_TIMEOUT_MS, QUICK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const syncBudgetFallback = presetValue(preset, REVIEW_SYNC_BUDGET_MS, QUICK_SYNC_BUDGET_MS, DEFAULT_SYNC_BUDGET_MS);
  const timeoutMs = normalizeTimeout(args.timeoutMs, timeoutFallback);
  const background = args.background === true;
  let syncBudgetMs = normalizeSyncBudgetWithFallback(args.syncBudgetMs, timeoutMs, background, syncBudgetFallback);
  const warnings = [];

  if (timeoutMs > 0 && syncBudgetMs > 0 && syncBudgetMs >= timeoutMs) {
    const adjusted = Math.max(0, timeoutMs - syncBudgetHeadroomMs(timeoutMs));
    warnings.push(
      adjusted > 0
        ? `syncBudgetMs (${syncBudgetMs}) was adjusted to ${adjusted} because it must be lower than timeoutMs (${timeoutMs}) to leave time for background polling before the hard timeout.`
        : `syncBudgetMs (${syncBudgetMs}) was adjusted to 0 (wait-for-completion mode) because timeoutMs (${timeoutMs}) is too small to leave a positive background polling window.`
    );
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
  return Math.min(30000, Math.max(1, Math.floor(timeoutMs * 0.1)));
}

function presetValue(preset, reviewValue, quickValue, fallback) {
  if (preset === "review") return reviewValue;
  if (preset === "quick") return quickValue;
  return fallback;
}

function resolveCwd(cwd) {
  const root = repoRoot();
  if (!cwd) return root;
  const resolved = path.resolve(root, cwd);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`cwd must stay under repository root: ${root}`);
  }
  const canonical = canonicalDirectory(resolved, "cwd");
  const canonicalRelative = path.relative(root, canonical);
  if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    throw new Error(`cwd must stay under repository root after resolving links: ${root}`);
  }
  return canonical;
}

function canonicalDirectory(value, label) {
  try {
    if (fs.statSync(value).isDirectory()) return fs.realpathSync.native(value);
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

function validateEffort(effort, provider = "claude") {
  if (effort === undefined || effort === null || effort === "") return undefined;
  if (provider === "gemini") {
    throw new Error("effort is not supported by gemini_task.");
  }
  const supported = provider === "antigravity" ? ANTIGRAVITY_EFFORTS : CLAUDE_EFFORTS;
  if (typeof effort !== "string" || !supported.has(effort)) {
    throw new Error(
      provider === "antigravity"
        ? "Antigravity effort must be one of: low, medium, high"
        : "Claude effort must be one of: low, medium, high, xhigh, max"
    );
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
    throw new Error(`preset must be one of: ${[...PRESETS].join(", ")}`);
  }
  return preset;
}

function validateMaxOutputChars(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_MAX_RESULT_CHARS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_RESULT_CHARS_LIMIT) {
    throw new Error(`maxOutputChars must be an integer from 0 to ${MAX_RESULT_CHARS_LIMIT}`);
  }
  return parsed;
}

function defaultModelForProvider(provider, preset) {
  if (provider === "claude") {
    return preset === "review"
      ? (process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL || "fable")
      : process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;
  }
  if (provider === "gemini") return process.env.CODEX_AI_BRIDGE_GEMINI_MODEL;
  if (provider === "antigravity") return process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL;
  return undefined;
}

function defaultEffortForProvider(provider, preset) {
  if (provider === "claude") {
    return process.env.CODEX_AI_BRIDGE_CLAUDE_EFFORT || presetValue(preset, "max", "low", undefined);
  }
  if (provider === "antigravity") {
    return process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT || presetValue(preset, "high", "low", undefined);
  }
  return undefined;
}

function defaultMaxTurnsForPreset(preset, provider) {
  if (provider !== "claude") return undefined;
  return presetValue(preset, REVIEW_MAX_TURNS, QUICK_MAX_TURNS, undefined);
}

function validateTaskArgs(args, options = {}) {
  if (!args || typeof args !== "object") throw new Error("arguments object is required");
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required");
  const policy = POLICIES.has(args.policy) ? args.policy : "advisory";
  if (policy === "agentic" && process.env.CODEX_AI_BRIDGE_ALLOW_AGENTIC !== "1") {
    throw new Error("agentic policy is disabled. Set CODEX_AI_BRIDGE_ALLOW_AGENTIC=1 to enable it explicitly.");
  }
  const timing = timingDefaults(args, options);
  const presetMaxTurns = defaultMaxTurnsForPreset(timing.preset, options.provider);
  return {
    ...args,
    preset: timing.preset,
    prompt: args.prompt.trim(),
    role: ROLES.has(args.role) ? args.role : (timing.preset === "review" ? "reviewer" : DEFAULT_ROLE),
    policy,
    cwd: resolveCwd(args.cwd),
    model: validateModel(args.model || defaultModelForProvider(options.provider, timing.preset)),
    effort: validateEffort(args.effort || defaultEffortForProvider(options.provider, timing.preset), options.provider),
    maxTurns: validateMaxTurns(args.maxTurns !== undefined && args.maxTurns !== null && args.maxTurns !== "" ? args.maxTurns : presetMaxTurns),
    maxOutputChars: validateMaxOutputChars(args.maxOutputChars),
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
  normalizeSyncBudgetWithFallback,
  resolveCwd,
  validateMaxOutputChars,
  validateModel,
  validateEffort,
  validateMaxTurns,
  validatePreset,
  validateTaskArgs,
  envJsonArray
};
