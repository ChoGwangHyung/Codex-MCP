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

{
  const args = validateTaskArgs({ prompt: "review this", preset: "review" }, { provider: "claude" });
  assert.equal(args.timeoutMs, REVIEW_TIMEOUT_MS);
  assert.equal(args.syncBudgetMs, REVIEW_SYNC_BUDGET_MS);
  assert.equal(args.model, "opus");
  assert.equal(args.effort, "max");
  assert.equal(args.maxTurns, REVIEW_MAX_TURNS);
  assert.equal(args.role, "reviewer");
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
