"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-hook-install-"));
const configFile = path.join(tempDir, "config.toml");
const hooksFile = path.join(tempDir, "hooks.json");
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_CONFIG_FILE = configFile;
process.env.CODEX_TELEGRAM_PERMISSION_HOOKS_FILE = hooksFile;
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND = "node hook.js";
process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND = "node stop-hook.js";
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";

const {
  ensureCodexHooksFeature,
  ensurePermissionHookInstalled,
  extractUnmanagedSections,
  maybeInstallPermissionHook,
  permissionHookScope,
  permissionHookStatus,
  permissionHookCommand,
  stopHookCommand,
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

assert.equal(
  ensureCodexHooksFeature("features.hooks = false\nmodel = \"gpt-5\"\n"),
  "features.hooks = true\nmodel = \"gpt-5\""
);

const first = ensurePermissionHookInstalled();
assert.equal(first.installed, true);
assert.equal(first.changed, true);
const installed = fs.readFileSync(configFile, "utf8");
assert.match(installed, /\[features]/);
assert.match(installed, /hooks = true/);
assert.doesNotMatch(installed, /codex_hooks/);
assert.doesNotMatch(installed, /\[\[hooks\.PermissionRequest]]/);
const installedHooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
assert.equal(installedHooks.hooks.PermissionRequest[0].hooks[0].command, "node hook.js");
assert.equal(installedHooks.hooks.PostToolUse[0].hooks[0].command, "node hook.js");
assert.equal(installedHooks.hooks.Stop[0].hooks[0].command, "node stop-hook.js");
assert.equal(stopHookCommand(), "node stop-hook.js");

const second = ensurePermissionHookInstalled();
assert.equal(second.installed, true);
assert.equal(second.changed, false);
assert.equal(permissionHookStatus().installed, true);
assert.equal(permissionHookScope(), "global");
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE = "local";
assert.equal(permissionHookScope(), "local");
delete process.env.CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE;

const originalPath = process.env.PATH;
const originalPermissionCommand = process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND;
const originalStopCommand = process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND;
const binDir = path.join(tempDir, "bin");
fs.mkdirSync(binDir);
writeTestCommand(binDir, "codex-telegram-permission-hook");
writeTestCommand(binDir, "codex-telegram-stop-hook");
process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
delete process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND;
delete process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND;
assert.equal(permissionHookCommand(), "codex-telegram-permission-hook");
assert.equal(stopHookCommand(), "codex-telegram-stop-hook");
process.env.PATH = originalPath;
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND = originalPermissionCommand;
process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND = originalStopCommand;

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
  "[[hooks.Stop]]",
  'matcher = "*"',
  "",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  'command = "node stop-hook.js"',
  "",
  "[hooks.state]",
  "",
  "[hooks.state.'R:\\workspace\\.codex\\config.toml:permission_request:0:0']",
  'trusted_hash = "sha256:abc"',
  "# END codex-telegram-bridge-mcp permission hook"
].join("\n");
const statefulCleaned = removeManagedHookBlock(statefulBlock);
assert.doesNotMatch(statefulCleaned, /codex-telegram-bridge-mcp permission hook/);
assert.match(statefulCleaned, /trusted_hash = "sha256:abc"/);

const blockWithUnrelatedTable = [
  "# BEGIN codex-telegram-bridge-mcp permission hook",
  "[[hooks.Stop]]",
  'matcher = "*"',
  "[[hooks.Stop.hooks]]",
  'command = "node stop-hook.js"',
  "[mcp_servers.example]",
  'command = "example"',
  "# END codex-telegram-bridge-mcp permission hook"
].join("\n");
assert.match(extractUnmanagedSections(blockWithUnrelatedTable), /\[mcp_servers\.example]/);
assert.match(removeManagedHookBlock(blockWithUnrelatedTable), /command = "example"/);

const maybe = maybeInstallPermissionHook();
assert.equal(maybe.installed, true);

function writeTestCommand(dir, name) {
  const file = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
