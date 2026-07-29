"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.CODEX_AI_BRIDGE_CLAUDE_COMMAND = process.execPath;
process.env.CODEX_AI_BRIDGE_GEMINI_COMMAND = process.execPath;
process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_COMMAND = process.execPath;
process.env.CODEX_AI_BRIDGE_GEMINI_MODEL = "gemini-test-model";
process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL = "gemini-3.6-flash-medium";
process.env.CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT = "medium";
process.env.CODEX_AI_BRIDGE_LOCK_DIR = path.join(os.tmpdir(), `codex-ai-bridge-provider-test-${process.pid}`);

const { askProvider } = require("../src/providers.js");

(async () => {
  const result = await askProvider("claude", {
    prompt: "x",
    maxTurns: 4,
    timeoutMs: 5000,
    syncBudgetMs: 0
  });
  assert.match(result, /claude failed:/);
  assert.match(result, /argv:/);
  assert.match(result, /--max-turns 4/);
  assert.match(result, /cwd:/);

  const geminiResult = await askProvider("gemini", {
    prompt: "x",
    maxTurns: 4,
    timeoutMs: 5000,
    syncBudgetMs: 0
  });
  assert.match(geminiResult, /gemini failed:/);
  assert.match(geminiResult, /argv:/);
  assert.match(geminiResult, /--model gemini-test-model/);
  assert.doesNotMatch(geminiResult, /--max-turns 4/);

  const antigravityResult = await askProvider("antigravity", {
    prompt: "x",
    maxTurns: 4,
    timeoutMs: 5000,
    syncBudgetMs: 0
  });
  assert.match(antigravityResult, /antigravity failed:/);
  assert.match(antigravityResult, /argv:/);
  assert.doesNotMatch(antigravityResult, /-p -/);
  assert.match(antigravityResult, /--print-timeout 5s/);
  assert.match(antigravityResult, /--sandbox/);
  assert.match(antigravityResult, /--mode plan/);
  assert.match(antigravityResult, /--model gemini-3\.6-flash-medium/);
  assert.match(antigravityResult, /--effort medium/);
  assert.doesNotMatch(antigravityResult, /--max-turns 4/);

  process.env.CODEX_AI_BRIDGE_CLAUDE_ARGS_JSON = JSON.stringify(["--api-key", "super-secret-value"]);
  const redacted = await askProvider("claude", {
    prompt: "x",
    timeoutMs: 5000,
    syncBudgetMs: 0
  });
  assert.match(redacted, /--api-key "?<redacted>"?/);
  assert.doesNotMatch(redacted, /super-secret-value/);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
