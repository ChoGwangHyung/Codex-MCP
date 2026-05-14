"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  allowedChatIds,
  bridgeEnabled
} = require("./config.js");
const { sanitize } = require("./util.js");

const HOOK_BEGIN = "# BEGIN codex-telegram-bridge-mcp permission hook";
const HOOK_END = "# END codex-telegram-bridge-mcp permission hook";

function maybeInstallPermissionHook() {
  try {
    if (!permissionHookAutoInstallEnabled()) {
      return { installed: false, reason: "auto-install disabled" };
    }
    if (!bridgeEnabled()) {
      return { installed: false, reason: "telegram bridge disabled" };
    }
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return { installed: false, reason: "telegram token missing" };
    }
    if (allowedChatIds().size === 0) {
      return { installed: false, reason: "no allowlisted chats" };
    }
    return ensurePermissionHookInstalled();
  } catch (error) {
    return { installed: false, reason: sanitize(error.message || "hook install failed") };
  }
}

function ensurePermissionHookInstalled() {
  const file = codexConfigPath();
  const permissionCommand = permissionHookCommand();
  const stopCommand = stopHookCommand();
  const before = readText(file);
  const withoutManagedBlock = removeManagedHookBlock(before);
  const withFeature = ensureCodexHooksFeature(withoutManagedBlock);
  const after = appendManagedHookBlock(withFeature, { permissionCommand, stopCommand });

  if (after !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
    return { installed: true, changed: true, path: file };
  }
  return { installed: true, changed: false, path: file };
}

function permissionHookStatus() {
  const file = codexConfigPath();
  const text = readText(file);
  if (!text) {
    return { installed: false, path: file };
  }
  return {
    installed: text.includes(HOOK_BEGIN) && text.includes(HOOK_END),
    path: file
  };
}

function permissionHookAutoInstallEnabled() {
  return process.env.CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL !== "0";
}

function codexConfigPath() {
  if (process.env.CODEX_TELEGRAM_PERMISSION_HOOK_CONFIG_FILE) {
    return process.env.CODEX_TELEGRAM_PERMISSION_HOOK_CONFIG_FILE;
  }
  if (permissionHookScope() === "local") {
    return path.join(process.cwd(), ".codex", "config.toml");
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

function permissionHookScope() {
  const value = String(process.env.CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE || "").trim().toLowerCase();
  if (value === "local" || value === "project") return "local";
  return "global";
}

function permissionHookCommand() {
  if (process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND) {
    return process.env.CODEX_TELEGRAM_PERMISSION_HOOK_COMMAND;
  }
  const script = path.join(__dirname, "..", "scripts", "codex-permission-telegram.js");
  return `node ${quoteCommandArg(script)}`;
}

function stopHookCommand() {
  if (process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND) {
    return process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND;
  }
  const script = path.join(__dirname, "..", "scripts", "codex-stop-telegram.js");
  return `node ${quoteCommandArg(script)}`;
}

function removeManagedHookBlock(text) {
  const pattern = new RegExp(`\\r?\\n?${escapeRegex(HOOK_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_END)}\\r?\\n?`, "g");
  return String(text || "")
    .replace(pattern, (block) => {
      const preserved = extractHookStateSection(block);
      return preserved ? `\n${preserved}\n` : "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function extractHookStateSection(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preserved = [];
  let preserving = false;
  for (const line of lines) {
    if (line === HOOK_BEGIN || line === HOOK_END) continue;
    if (/^\s*\[hooks\.state(?:\]|\.)/.test(line)) preserving = true;
    else if (preserving && /^\s*\[/.test(line) && !/^\s*\[hooks\.state(?:\]|\.)/.test(line)) preserving = false;
    if (preserving) preserved.push(line);
  }
  return preserved.join("\n").trim();
}

function ensureCodexHooksFeature(text) {
  const content = String(text || "");
  const lines = content.split(/\r?\n/);
  const featureHeaderIndex = lines.findIndex((line) => /^\s*\[features]\s*$/.test(line));

  if (featureHeaderIndex < 0) {
    return appendSection(content, ["[features]", "hooks = true"].join("\n"));
  }

  let nextTableIndex = lines.length;
  for (let index = featureHeaderIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      nextTableIndex = index;
      break;
    }
  }

  let hasHooksFeature = false;
  for (let index = nextTableIndex - 1; index > featureHeaderIndex; index -= 1) {
    if (/^\s*codex_hooks\s*=/.test(lines[index])) {
      lines.splice(index, 1);
      nextTableIndex -= 1;
      continue;
    }
    if (/^\s*hooks\s*=/.test(lines[index])) {
      lines[index] = "hooks = true";
      hasHooksFeature = true;
    }
  }

  if (!hasHooksFeature) {
    lines.splice(featureHeaderIndex + 1, 0, "hooks = true");
  }
  return lines.join("\n").trimEnd();
}

function appendManagedHookBlock(text, { permissionCommand, stopCommand }) {
  return appendSection(text, [
    HOOK_BEGIN,
    "[[hooks.PermissionRequest]]",
    'matcher = "*"',
    "",
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(permissionCommand)}`,
    "timeout = 330",
    'statusMessage = "Waiting for Telegram approval"',
    "",
    "[[hooks.PostToolUse]]",
    'matcher = "*"',
    "",
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(permissionCommand)}`,
    "timeout = 30",
    'statusMessage = "Updating Telegram approval state"',
    "",
    "[[hooks.Stop]]",
    'matcher = "*"',
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(stopCommand)}`,
    "timeout = 30",
    'statusMessage = "Sending Telegram reply"',
    HOOK_END
  ].join("\n"));
}

function appendSection(text, section) {
  const content = String(text || "").trimEnd();
  if (!content) return `${section}\n`;
  return `${content}\n\n${section}\n`;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function quoteCommandArg(value) {
  const text = String(value || "");
  return /[\s&()[\]{}^=;!'+,`~]/.test(text)
    ? `"${text.replace(/"/g, '\\"')}"`
    : text;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  maybeInstallPermissionHook,
  ensurePermissionHookInstalled,
  permissionHookStatus,
  codexConfigPath,
  permissionHookCommand,
  stopHookCommand,
  permissionHookScope,
  ensureCodexHooksFeature,
  removeManagedHookBlock,
  extractHookStateSection
};
