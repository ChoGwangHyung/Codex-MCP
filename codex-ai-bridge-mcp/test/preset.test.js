"use strict";

const assert = require("node:assert/strict");
const { validateTaskArgs } = require("../src/config.js");
const {
  QUICK_MAX_TURNS,
  QUICK_SYNC_BUDGET_MS,
  QUICK_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS
} = require("../src/constants.js");

const savedEffort = process.env.CODEX_AI_BRIDGE_CLAUDE_EFFORT;
const savedAntigravityEffort = process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT;
const savedModel = process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;

try {
  delete process.env.CODEX_AI_BRIDGE_CLAUDE_EFFORT;
  delete process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT;
  delete process.env.CODEX_AI_BRIDGE_CLAUDE_MODEL;

  {
    const args = validateTaskArgs({ prompt: "short question", preset: "quick" }, { provider: "claude" });
    assert.equal(args.timeoutMs, QUICK_TIMEOUT_MS);
    assert.equal(args.syncBudgetMs, QUICK_SYNC_BUDGET_MS);
    assert.equal(args.maxTurns, QUICK_MAX_TURNS);
    assert.equal(args.effort, "low");
    assert.ok(args.timeoutMs < REVIEW_TIMEOUT_MS, "quick must be faster than review");
  }

  {
    const args = validateTaskArgs({ prompt: "short question", preset: "quick" }, { provider: "antigravity" });
    assert.equal(args.effort, "low");
    assert.equal(args.maxTurns, undefined, "only Claude takes a turn limit");
  }

  {
    const args = validateTaskArgs({ prompt: "short question", preset: "quick" }, { provider: "gemini" });
    assert.equal(args.effort, undefined, "gemini rejects effort entirely");
  }

  {
    const args = validateTaskArgs(
      { prompt: "short question", preset: "quick", timeoutMs: 300000, effort: "high" },
      { provider: "claude" }
    );
    assert.equal(args.timeoutMs, 300000, "explicit arguments beat the preset");
    assert.equal(args.effort, "high");
  }

  assert.throws(
    () => validateTaskArgs({ prompt: "x", preset: "turbo" }, { provider: "claude" }),
    /preset must be one of: review, quick/
  );
} finally {
  restore("CODEX_AI_BRIDGE_CLAUDE_EFFORT", savedEffort);
  restore("CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT", savedAntigravityEffort);
  restore("CODEX_AI_BRIDGE_CLAUDE_MODEL", savedModel);
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
