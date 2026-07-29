"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

// An unattached background rejection used to terminate the process under
// Node's default --unhandled-rejections=throw, dropping any in-flight tool
// call without a JSON-RPC error. The server must stay up and keep answering.
const entry = path.join(__dirname, "..", "src", "index.js");
const preload = path.join(__dirname, "fixtures", "inject-rejection.js");

const child = spawn(process.execPath, ["--require", preload, entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CODEX_TELEGRAM_BRIDGE_ENABLED: "0",
    CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL: "0"
  }
});

let stdout = "";
let stderr = "";
let exited = null;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("exit", (code, signal) => { exited = { code, signal }; });

(async () => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  await delay(1200);

  assert.equal(exited, null, `server exited after a background rejection: ${stderr.trim()}`);
  assert.match(stderr, /unhandled rejection/i, "the fault is reported on stderr");
  assert.match(stderr, /injected background rejection/, "the original reason is preserved");
  assert.doesNotMatch(stdout, /unhandled rejection/i, "diagnostics never enter the JSON-RPC stream");

  // Still serving after the fault.
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await delay(800);

  const replies = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const toolsReply = replies.find((message) => message.id === 2);
  assert.ok(toolsReply && toolsReply.result, "tools/list is answered after the rejection");
  assert.ok(toolsReply.result.tools.length > 0);

  child.kill();
})().catch((error) => {
  child.kill();
  console.error(error);
  process.exit(1);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
