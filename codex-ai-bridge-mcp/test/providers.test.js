"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.CODEX_AI_BRIDGE_CLAUDE_COMMAND = process.execPath;
process.env.CODEX_AI_BRIDGE_GEMINI_COMMAND = process.execPath;
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
  assert.doesNotMatch(geminiResult, /--max-turns 4/);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
