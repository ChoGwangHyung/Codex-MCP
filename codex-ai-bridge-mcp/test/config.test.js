"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
    assert.equal(args.model, "fable");
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

  {
    const args = validateTaskArgs({ prompt: "review this", preset: "review" }, { provider: "antigravity" });
    assert.equal(args.effort, "high");
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
  const args = validateTaskArgs({ prompt: "x", timeoutMs: 500, syncBudgetMs: 500 }, { provider: "claude" });
  assert.equal(args.syncBudgetMs, 450);
  assert.ok(args.syncBudgetMs > 0);
}

{
  const args = validateTaskArgs({ prompt: "x", timeoutMs: 1, syncBudgetMs: 1 }, { provider: "claude" });
  assert.equal(args.syncBudgetMs, 0);
  assert.match(args.warnings.join("\n"), /wait-for-completion/);
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

assert.throws(
  () => validateTaskArgs({ prompt: "x", effort: "max" }, { provider: "antigravity" }),
  /Antigravity effort/
);

assert.throws(
  () => validateTaskArgs({ prompt: "x", effort: "high" }, { provider: "gemini" }),
  /not supported/
);

{
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ai-outside-"));
  const link = path.join(process.cwd(), `__ai_bridge_escape_link_${process.pid}__`);
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => validateTaskArgs({ prompt: "x", cwd: path.basename(link) }, { provider: "claude" }),
      /after resolving links/
    );
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}
