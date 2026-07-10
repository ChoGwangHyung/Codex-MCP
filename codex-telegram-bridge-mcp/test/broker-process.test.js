"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-broker-process-"));
const brokerFile = path.join(tempDir, "broker.json");
const localStateFile = path.join(tempDir, "telegram-state.json");
const brokerModule = path.join(__dirname, "..", "src", "broker.js");
const worker = [
  "const broker = require(process.argv[1]);",
  "const id = process.argv[2];",
  "broker.pollBrokerUpdates(async () => [], 0, {",
  "  consumer: { id, shortId: id.slice(0, 8), label: `Project-${id}`, cwd: process.cwd() },",
  "  allowedChatIds: ['10']",
  "}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });"
].join("\n");

(async () => {
  await Promise.all(Array.from({ length: 6 }, (_, index) => runWorker(`consumer-${index}`)));
  const state = JSON.parse(fs.readFileSync(brokerFile, "utf8"));
  assert.equal(Object.keys(state.consumers).length, 6);
  assert.equal(state.updateOffset, 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function runWorker(id) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(process.execPath, ["-e", worker, brokerModule, id], {
      cwd: tempDir,
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "test-bot-token",
        CODEX_TELEGRAM_BROKER_STATE_FILE: brokerFile,
        CODEX_TELEGRAM_BRIDGE_STATE_FILE: localStateFile
      },
      windowsHide: true,
      timeout: 30000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}
