"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
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
  const configFile = codexConfigPath();
  const hooksFile = codexHooksPath();
  const permissionCommand = permissionHookCommand();
  const stopCommand = stopHookCommand();
  const configBefore = readText(configFile);
  const configAfter = `${ensureCodexHooksFeature(removeManagedHookBlock(configBefore)).trimEnd()}\n`;
  const hooksBefore = readHooksFile(hooksFile);
  const hooksAfter = upsertManagedHooks(hooksBefore.value, { permissionCommand, stopCommand });
  const hooksBeforeText = hooksBefore.exists ? stableHooksJson(hooksBefore.value) : "";
  const hooksAfterText = stableHooksJson(hooksAfter);
  let changed = false;

  if (configAfter !== configBefore) {
    writeTextAtomic(configFile, configAfter);
    changed = true;
  }
  if (hooksAfterText !== hooksBeforeText) {
    writeTextAtomic(hooksFile, hooksAfterText);
    changed = true;
  }
  return { installed: true, changed, path: hooksFile, configPath: configFile };
}

function permissionHookStatus() {
  const file = codexHooksPath();
  let hooks;
  try {
    hooks = readHooksFile(file);
  } catch (error) {
    return { installed: false, path: file, configPath: codexConfigPath(), reason: sanitize(error.message) };
  }
  const commands = managedHookCommands(hooks.value);
  return {
    installed: commands.has(permissionHookCommand()) && commands.has(stopHookCommand()),
    path: file,
    configPath: codexConfigPath()
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

function codexHooksPath() {
  if (process.env.CODEX_TELEGRAM_PERMISSION_HOOKS_FILE) {
    return process.env.CODEX_TELEGRAM_PERMISSION_HOOKS_FILE;
  }
  if (permissionHookScope() === "local") {
    return path.join(process.cwd(), ".codex", "hooks.json");
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "hooks.json");
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
  if (permissionHookScope() === "global" && commandAvailable("codex-telegram-permission-hook")) {
    return "codex-telegram-permission-hook";
  }
  const script = path.join(__dirname, "..", "scripts", "codex-permission-telegram.js");
  return `node ${quoteCommandArg(script)}`;
}

function stopHookCommand() {
  if (process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND) {
    return process.env.CODEX_TELEGRAM_STOP_HOOK_COMMAND;
  }
  if (permissionHookScope() === "global" && commandAvailable("codex-telegram-stop-hook")) {
    return "codex-telegram-stop-hook";
  }
  const script = path.join(__dirname, "..", "scripts", "codex-stop-telegram.js");
  return `node ${quoteCommandArg(script)}`;
}

function commandAvailable(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5000
  });
  return !result.error && result.status === 0;
}

function removeManagedHookBlock(text) {
  const pattern = new RegExp(`\\r?\\n?${escapeRegex(HOOK_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_END)}\\r?\\n?`, "g");
  return String(text || "")
    .replace(pattern, (block) => {
      const preserved = extractUnmanagedSections(block);
      return preserved ? `\n${preserved}\n` : "\n";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function extractUnmanagedSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const preserved = [];
  let managedSection = true;
  for (const line of lines) {
    if (line === HOOK_BEGIN || line === HOOK_END) continue;
    if (/^\s*\[/.test(line)) {
      managedSection = /^\s*\[\[hooks\.(?:PermissionRequest|PostToolUse|Stop)(?:\.hooks)?]]\s*$/.test(line);
    }
    if (!managedSection) preserved.push(line);
  }
  return preserved.join("\n").trim();
}

function upsertManagedHooks(input, { permissionCommand, stopCommand }) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? structuredClone(input) : {};
  const hooks = value.hooks && typeof value.hooks === "object" && !Array.isArray(value.hooks) ? value.hooks : {};
  const definitions = {
    PermissionRequest: managedHookGroup(permissionCommand, 330, "Waiting for Telegram approval"),
    PostToolUse: managedHookGroup(permissionCommand, 30, "Updating Telegram approval state"),
    Stop: managedHookGroup(stopCommand, 30, "Sending Telegram reply")
  };

  for (const [event, definition] of Object.entries(definitions)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = groups.map((group) => {
      if (!group || typeof group !== "object") return group;
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((handler) => !isManagedTelegramHandler(handler, permissionCommand, stopCommand))
        : [];
      return { ...group, hooks: handlers };
    }).filter((group) => group && Array.isArray(group.hooks) && group.hooks.length > 0);
    hooks[event] = [...cleaned, definition];
  }
  value.hooks = hooks;
  return value;
}

function managedHookGroup(command, timeout, statusMessage) {
  return {
    matcher: "*",
    hooks: [{ type: "command", command, timeout, statusMessage }]
  };
}

function isManagedTelegramHandler(handler, permissionCommand, stopCommand) {
  const command = String(handler && handler.command || "");
  return command === permissionCommand || command === stopCommand ||
    /(?:codex-(?:permission|stop)-telegram(?:\.js)?|codex-telegram-(?:permission|stop)-hook)\b/i.test(command);
}

function managedHookCommands(value) {
  const commands = new Set();
  const hooks = value && value.hooks && typeof value.hooks === "object" ? value.hooks : {};
  for (const event of ["PermissionRequest", "PostToolUse", "Stop"]) {
    for (const group of Array.isArray(hooks[event]) ? hooks[event] : []) {
      for (const handler of Array.isArray(group && group.hooks) ? group.hooks : []) {
        if (handler && handler.type === "command") commands.add(String(handler.command || ""));
      }
    }
  }
  return commands;
}

function readHooksFile(file) {
  const text = readText(file);
  if (!text.trim()) return { exists: false, value: {} };
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`Invalid Codex hooks JSON at ${file}: ${error.message}`);
  }
}

function stableHooksJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function ensureCodexHooksFeature(text) {
  const content = String(text || "");
  const lines = content.split(/\r?\n/);
  let featureHeaderIndex = lines.findIndex((line) => /^\s*\[features]\s*$/.test(line));

  if (featureHeaderIndex < 0) {
    const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
    const rootEnd = firstTableIndex < 0 ? lines.length : firstTableIndex;
    let dottedHooksIndex = -1;
    for (let index = rootEnd - 1; index >= 0; index -= 1) {
      if (/^\s*features\.codex_hooks\s*=/.test(lines[index])) {
        lines.splice(index, 1);
        if (dottedHooksIndex > index) dottedHooksIndex -= 1;
        continue;
      }
      if (/^\s*features\.hooks\s*=/.test(lines[index])) dottedHooksIndex = index;
    }
    if (dottedHooksIndex >= 0) {
      lines[dottedHooksIndex] = "features.hooks = true";
      return lines.join("\n").trimEnd();
    }
    return appendSection(content, ["[features]", "hooks = true"].join("\n"));
  }

  for (let index = featureHeaderIndex - 1; index >= 0; index -= 1) {
    if (/^\s*features\.(?:codex_hooks|hooks)\s*=/.test(lines[index])) {
      lines.splice(index, 1);
      featureHeaderIndex -= 1;
    }
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
  codexHooksPath,
  permissionHookCommand,
  stopHookCommand,
  permissionHookScope,
  ensureCodexHooksFeature,
  removeManagedHookBlock,
  extractUnmanagedSections,
  upsertManagedHooks
};
