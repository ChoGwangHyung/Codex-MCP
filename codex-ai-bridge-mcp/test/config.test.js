"use strict";

const assert = require("node:assert/strict");
const { validateTaskArgs } = require("../src/config.js");
const {
  DEFAULT_SYNC_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  REVIEW_MAX_TURNS,
  REVIEW_SYNC_BUDGET_MS,
  REVIEW_TIMEOUT_MS
} = require("../src/constants.js");

assert.equal(DEFAULT_TIMEOUT_MS, 900000);
assert.equal(DEFAULT_SYNC_BUDGET_MS, 120000);

const originalClaudeModel = process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;
const originalGeminiModel = process.env.CODEX_AI_BRIDGE_GEMINI_MODEL;
const originalAntigravityModel = process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL;

try {
  delete process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;
  delete process.env.CODEX_AI_BRIDGE_GEMINI_MODEL;
  delete process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL;
  {
    const args = validateTaskArgs({ prompt: "review this", preset: "review" }, { provider: "claude" });
    assert.equal(args.timeoutMs, REVIEW_TIMEOUT_MS);
    assert.equal(args.syncBudgetMs, REVIEW_SYNC_BUDGET_MS);
    assert.equal(args.model, "claude-fable-5");
    assert.equal(args.effort, "max");
    assert.equal(args.maxTurns, REVIEW_MAX_TURNS);
    assert.equal(args.role, "reviewer");
  }

  process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL = "claude-custom-review";
  {
    const args = validateTaskArgs({ prompt: "review this", preset: "review" }, { provider: "claude" });
    assert.equal(args.model, "claude-custom-review");
  }

  {
    const args = validateTaskArgs({ prompt: "review this", preset: "review", model: "claude-explicit-review" }, { provider: "claude" });
    assert.equal(args.model, "claude-explicit-review");
  }

  process.env.CODEX_AI_BRIDGE_GEMINI_MODEL = "gemini-3.5-flash";
  {
    const args = validateTaskArgs({ prompt: "review this" }, { provider: "gemini" });
    assert.equal(args.model, "gemini-3.5-flash");
  }

  process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL = "Gemini 3.5 Flash (Medium)";
  {
    const args = validateTaskArgs({ prompt: "review this" }, { provider: "antigravity" });
    assert.equal(args.model, "Gemini 3.5 Flash (Medium)");
  }

  {
    const args = validateTaskArgs({ prompt: "review this", model: "Gemini 3.1 Pro (high)" }, { provider: "antigravity" });
    assert.equal(args.model, "Gemini 3.1 Pro (high)");
  }
} finally {
  if (originalClaudeModel === undefined) {
    delete process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;
  } else {
    process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL = originalClaudeModel;
  }
  if (originalGeminiModel === undefined) {
    delete process.env.CODEX_AI_BRIDGE_GEMINI_MODEL;
  } else {
    process.env.CODEX_AI_BRIDGE_GEMINI_MODEL = originalGeminiModel;
  }
  if (originalAntigravityModel === undefined) {
    delete process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL;
  } else {
    process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL = originalAntigravityModel;
  }
}

{
  const args = validateTaskArgs({ prompt: "review this", preset: "review", maxTurns: 6 }, { provider: "claude" });
  assert.equal(args.maxTurns, 6);
}

{
  const args = validateTaskArgs({ prompt: "review this", maxTurns: 6 }, { provider: "gemini" });
  assert.equal(args.maxTurns, 6);
}

{
  const args = validateTaskArgs({ prompt: "review this", maxTurns: 6 }, { provider: "antigravity" });
  assert.equal(args.maxTurns, 6);
}

{
  const args = validateTaskArgs({ prompt: "x", timeoutMs: 120000, syncBudgetMs: 120000 }, { provider: "claude" });
  assert.equal(args.timeoutMs, 120000);
  assert.equal(args.syncBudgetMs, 108000);
  assert.match(args.warnings.join("\n"), /syncBudgetMs/);
}

{
  const args = validateTaskArgs({ prompt: "x", timeoutMs: 900000, syncBudgetMs: 0 }, { provider: "gemini" });
  assert.equal(args.syncBudgetMs, 0);
  assert.deepEqual(args.warnings, []);
}

assert.throws(
  () => validateTaskArgs({ prompt: "x", cwd: "__missing_ai_bridge_cwd__" }, { provider: "claude" }),
  /cwd must exist and be a directory/
);

assert.throws(
  () => validateTaskArgs({ prompt: "x", maxTurns: 0 }, { provider: "claude" }),
  /maxTurns must be an integer/
);
