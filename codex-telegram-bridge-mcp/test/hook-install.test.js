"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-hook-install-"));
const configFile = path.join(tempDir, "config.toml");
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_CONFIG_FILE = configFile;
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND = "node hook.js";
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";

const {
  ensureCodexHooksFeature,
  ensurePermissionHookInstalled,
  extractHookStateSection,
  maybeInstallPermissionHook,
  permissionHookScope,
  permissionHookStatus,
  removeManagedHookBlock
} = require("../src/hook-install.js");

assert.equal(
  ensureCodexHooksFeature("model = \"gpt-5\"\n").trimEnd(),
  "model = \"gpt-5\"\n\n[features]\nhooks = true"
);

assert.equal(
  ensureCodexHooksFeature("[features]\nfoo = true\n[projects.x]\ntrust_level = \"trusted\"\n"),
  "[features]\nhooks = true\nfoo = true\n[projects.x]\ntrust_level = \"trusted\""
);

assert.equal(
  ensureCodexHooksFeature("[features]\ncodex_hooks = false\n"),
  "[features]\nhooks = true"
);

assert.equal(
  ensureCodexHooksFeature("[features]\ncodex_hooks = true\nhooks = false\n"),
  "[features]\nhooks = true"
);

const first = ensurePermissionHookInstalled();
assert.equal(first.installed, true);
assert.equal(first.changed, true);
const installed = fs.readFileSync(configFile, "utf8");
assert.match(installed, /\[features]/);
assert.match(installed, /hooks = true/);
assert.doesNotMatch(installed, /codex_hooks/);
assert.match(installed, /\[\[hooks\.PermissionRequest]]/);
assert.match(installed, /\[\[hooks\.PostToolUse]]/);
assert.match(installed, /node hook\.js/);

const second = ensurePermissionHookInstalled();
assert.equal(second.installed, true);
assert.equal(second.changed, false);
assert.equal(permissionHookStatus().installed, true);
assert.equal(permissionHookScope(), "global");
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE = "local";
assert.equal(permissionHookScope(), "local");
delete process.env.CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE;

const cleaned = removeManagedHookBlock(installed);
assert.doesNotMatch(cleaned, /codex-telegram-bridge-mcp permission hook/);

const statefulBlock = [
  "# BEGIN codex-telegram-bridge-mcp permission hook",
  "[[hooks.PermissionRequest]]",
  'matcher = "*"',
  "",
  "[[hooks.PermissionRequest.hooks]]",
  'type = "command"',
  'command = "node hook.js"',
  "",
  "[hooks.state]",
  "",
  "[hooks.state.'C:\\Users\\me\\.codex\\config.toml:permission_request:0:0']",
  'trusted_hash = "sha256:abc"',
  "# END codex-telegram-bridge-mcp permission hook"
].join("\n");
assert.match(extractHookStateSection(statefulBlock), /\[hooks\.state]/);
const statefulCleaned = removeManagedHookBlock(statefulBlock);
assert.doesNotMatch(statefulCleaned, /codex-telegram-bridge-mcp permission hook/);
assert.match(statefulCleaned, /trusted_hash = "sha256:abc"/);

const maybe = maybeInstallPermissionHook();
assert.equal(maybe.installed, true);
