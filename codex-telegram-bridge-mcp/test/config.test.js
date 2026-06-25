"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-config-test-"));
const projectDir = path.join(tempDir, "project");
const codexDir = path.join(projectDir, ".codex");
const envFile = path.join(codexDir, "config.toml.env");
const accessFile = path.join(codexDir, "config.toml.access.json");
const originalCwd = process.cwd();
const envKeys = [
  "CODEX_TELEGRAM_BRIDGE_ENV_FILE",
  "CODEX_TELEGRAM_BRIDGE_CONFIG_FILE",
  "CODEX_TELEGRAM_BRIDGE_CONFIG_DIR",
  "CODEX_TELEGRAM_BRIDGE_STATE_DIR",
  "CODEX_TELEGRAM_BRIDGE_STATE_FILE",
  "CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR",
  "CODEX_TELEGRAM_BRIDGE_DOWNLOAD_DIR",
  "CODEX_TELEGRAM_BRIDGE_ACCESS_FILE",
  "CODEX_TELEGRAM_BRIDGE_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_IDS"
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function resetConfigModule() {
  delete require.cache[require.resolve("../src/config.js")];
  return require("../src/config.js");
}

try {
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(envFile, [
    "CODEX_TELEGRAM_BRIDGE_ENABLED=1",
    "TELEGRAM_BOT_TOKEN=123456:abcdefghijklmnopqrstuvwxyz",
    ""
  ].join("\n"));
  fs.writeFileSync(accessFile, JSON.stringify({
    dmPolicy: "allowlist",
    allowFrom: ["12345"],
    groups: {},
    pending: {}
  }));

  for (const key of envKeys) delete process.env[key];
  process.chdir(projectDir);

  {
    const config = resetConfigModule();
    assert.equal(config.telegramEnvPath(), envFile);
    assert.equal(config.telegramAccessPath(), path.join(codexDir, "config.toml.access.json"));
    assert.equal(config.telegramStatePath(), path.join(codexDir, "telegram-runtime", "telegram-state.json"));
    assert.equal(config.telegramDownloadDir(), path.join(codexDir, "telegram-runtime", "downloads"));
    assert.equal(config.bridgeEnabled(), true);
    assert.equal(config.telegramEnabled(), true);
  }

  for (const key of envKeys) delete process.env[key];
  process.chdir(projectDir);
  process.env.CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR = path.join(tempDir, "custom-runtime");
  {
    const config = resetConfigModule();
    assert.equal(config.telegramStatePath(), path.join(tempDir, "custom-runtime", "telegram-state.json"));
  }
} finally {
  process.chdir(originalCwd);
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  delete require.cache[require.resolve("../src/config.js")];
}
