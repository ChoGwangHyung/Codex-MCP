#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HOOK_BEGIN = "# BEGIN codex-done-notifier hook";
const HOOK_END = "# END codex-done-notifier hook";
const HOOK_CONFIG_PREFIX = "# codex-done-notifier-config ";

async function main(argv = process.argv) {
  const command = String(argv[2] || "help").toLowerCase();
  try {
    if (command === "configure") return configure(argv.slice(3));
    if (command === "unconfigure") return unconfigure(argv.slice(3));
    if (command === "enable") return enable(argv.slice(3));
    if (command === "disable") return disable(argv.slice(3));
    if (command === "status") return status(argv.slice(3));
    if (command === "hook") return hook(argv.slice(3));
    if (command === "test") return testNotification();
    if (command === "hook-snippet") return printHookSnippet();
    usage(command === "help" ? 0 : 1);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}

function configure(args = []) {
  if (hasFlag(args, "--no-enable")) {
    const result = ensureHookInstalled({
      global: hasFlag(args, "--global"),
      cwd: process.cwd(),
      hookConfig: disabledHookConfig()
    });
    console.log(`${result.changed ? "installed" : "already installed"}: ${result.path}`);
    return;
  }
  enable(args);
}

function unconfigure(args = []) {
  const file = codexConfigPath({ global: hasFlag(args, "--global"), cwd: process.cwd() });
  const before = readText(file);
  const after = removeManagedHookBlock(before);
  if (after !== before) fs.writeFileSync(file, after ? `${after.trimEnd()}\n` : "");
  console.log(`removed: ${file}`);
}

function enable(args = []) {
  const cwd = process.cwd();
  const global = hasFlag(args, "--global");
  const existingConfig = currentNotifierConfig({ global, cwd });
  const baseConfig = existingConfig.configured ? existingConfig : {};
  const sessionId = optionValue(args, "--session");
  const sound = optionValue(args, "--sound");
  const soundFile = optionValue(args, "--sound-file");
  const hasSoundSetting = hasSoundOverride(args);
  const hasNotificationSetting = hasNotificationOverride(args);
  const hasOutputOverride = hasSoundSetting || hasNotificationSetting;
  const restorePreviousOutputs = !hasOutputOverride && baseConfig.enabled === false && markerHasOutput(baseConfig);
  const soundEnabled = restorePreviousOutputs
    ? markerSoundEnabled(baseConfig)
    : hasOutputOverride ? hasSoundSetting ? requestedSoundEnabled(args, sound) : markerSoundEnabled(baseConfig) : true;
  const desktopNotificationEnabled = restorePreviousOutputs
    ? markerNotificationEnabled(baseConfig)
    : hasOutputOverride ? hasNotificationSetting ? requestedNotificationEnabled(args) : markerNotificationEnabled(baseConfig) : true;
  const selectedSound = sound || baseConfig.sound || defaultSoundName();
  const selectedSoundFile = soundFile
    ? path.resolve(cwd, soundFile)
    : typeof baseConfig.soundFile === "string" ? baseConfig.soundFile : "";
  const config = {
    enabled: soundEnabled || desktopNotificationEnabled,
    sessions: sessionId ? [sessionId] : [],
    sound: selectedSound,
    soundFile: selectedSoundFile,
    soundEnabled,
    notificationEnabled: desktopNotificationEnabled
  };
  const result = ensureHookInstalled({ global, cwd, hookConfig: config });
  console.log(`${config.enabled ? "enabled" : "disabled"}: ${result.path}`);
  if (!config.enabled) console.log("reason: no outputs enabled");
  if (sessionId) console.log(`session: ${sessionId}`);
  console.log(`sound: ${soundEnabled ? selectedSound : "off"}`);
  console.log(`notification: ${desktopNotificationEnabled ? "on" : "off"}`);
  if (soundEnabled && selectedSoundFile) console.log(`sound_file: ${selectedSoundFile}`);
}

function disable(args = []) {
  const cwd = process.cwd();
  const global = hasFlag(args, "--global");
  const existingConfig = currentNotifierConfig({ global, cwd });
  const baseConfig = existingConfig.configured ? existingConfig : {};
  const result = ensureHookInstalled({
    global,
    cwd,
    hookConfig: {
      enabled: false,
      sessions: markerSessions(baseConfig),
      sound: baseConfig.sound || defaultSoundName(),
      soundFile: typeof baseConfig.soundFile === "string" ? baseConfig.soundFile : "",
      soundEnabled: markerSoundEnabled(baseConfig),
      notificationEnabled: markerNotificationEnabled(baseConfig)
    }
  });
  console.log(`disabled: ${result.path}`);
}

function status(args = []) {
  const cwd = process.cwd();
  const localHookStatus = doneHookStatus({ global: false, cwd });
  const globalHookStatus = doneHookStatus({ global: true, cwd });
  const selectedHookStatus = hasFlag(args, "--global") ? globalHookStatus : localHookStatus;
  const config = selectedHookStatus.configured ? selectedHookStatus : {};
  const enabled = selectedHookStatus.installed && config.enabled !== false && markerHasOutput(config);
  console.log(`hook_installed: ${selectedHookStatus.installed ? "yes" : "no"}`);
  console.log(`hook_config: ${selectedHookStatus.path}`);
  console.log(`hook_reviewed: ${selectedHookStatus.reviewed ? "yes" : "no"}`);
  if (selectedHookStatus.reviewedPath) console.log(`hook_reviewed_in: ${selectedHookStatus.reviewedPath}`);
  console.log(`local_hook_installed: ${localHookStatus.installed ? "yes" : "no"}`);
  console.log(`local_hook_config: ${localHookStatus.path}`);
  console.log(`local_hook_reviewed: ${localHookStatus.reviewed ? "yes" : "no"}`);
  console.log(`global_hook_installed: ${globalHookStatus.installed ? "yes" : "no"}`);
  console.log(`global_hook_config: ${globalHookStatus.path}`);
  console.log(`global_hook_reviewed: ${globalHookStatus.reviewed ? "yes" : "no"}`);
  console.log(`cwd: ${cwd}`);
  console.log(`enabled_here: ${enabled ? "yes" : "no"}`);
  if (selectedHookStatus.installed) {
    console.log(`config_enabled: ${config.enabled === false ? "no" : "yes"}`);
    console.log(`sound: ${markerSoundEnabled(config) ? config.sound || defaultSoundName() : "off"}`);
    console.log(`notification: ${markerNotificationEnabled(config) ? "on" : "off"}`);
    if (markerSoundEnabled(config) && config.soundFile) console.log(`sound_file: ${config.soundFile}`);
  }
  console.log(`session_env_enabled: ${process.env.CODEX_DONE_NOTIFIER_ENABLED === "1" ? "yes" : "no"}`);
}

async function hook(args = []) {
  const input = parseJson(await readStdin());
  await handleHookInput(input, hookConfigFromArgs(args));
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
}

async function testNotification() {
  const localConfig = currentNotifierConfig({ global: false, cwd: process.cwd() });
  const globalConfig = currentNotifierConfig({ global: true, cwd: process.cwd() });
  const markerConfig = localConfig.configured ? localConfig : globalConfig.configured ? globalConfig : defaultHookConfig();
  await sendNotification({
    title: process.env.CODEX_DONE_NOTIFIER_TITLE || "Codex task completed",
    body: "codex-done-notifier test notification",
    sound: notificationSound(markerConfig),
    soundFile: notificationSoundFile(markerConfig),
    soundEnabled: markerSoundEnabled(markerConfig),
    notificationEnabled: markerNotificationEnabled(markerConfig)
  });
  console.log("sent");
}

function printHookSnippet() {
  process.stdout.write(`${ensureCodexHooksFeature("")}${appendManagedHookBlock("", defaultHookConfig()).trimEnd()}\n`);
}

async function handleHookInput(input, hookConfig = {}) {
  const cwd = String(input && input.cwd || process.cwd());
  const sessionId = String(input && (input.session_id || input.sessionId) || "");
  if (!shouldNotify({ sessionId, hookConfig })) {
    return { notified: false, reason: "not enabled" };
  }

  const markerConfig = hookConfig.configured ? hookConfig : defaultHookConfig();
  await sendNotification({
    title: process.env.CODEX_DONE_NOTIFIER_TITLE || "Codex task completed",
    body: notificationBody(input, cwd),
    sound: notificationSound(markerConfig),
    soundFile: notificationSoundFile(markerConfig),
    soundEnabled: markerSoundEnabled(markerConfig),
    notificationEnabled: markerNotificationEnabled(markerConfig)
  });
  return { notified: true, config: markerConfig };
}

function shouldNotify({ sessionId, hookConfig = {} }) {
  if (process.env.CODEX_DONE_NOTIFIER_ENABLED === "1") return true;
  if (sessionId && sessionList(process.env.CODEX_DONE_NOTIFIER_SESSION_IDS).includes(sessionId)) return true;
  if (hookConfig.configured) {
    if (hookConfig.enabled === false) return false;
    if (!markerHasOutput(hookConfig)) return false;
    const sessions = markerSessions(hookConfig);
    if (sessions.length > 0) return sessionId ? sessions.includes(sessionId) : false;
    return true;
  }
  return false;
}

function notificationBody(input, cwd) {
  const name = path.basename(path.resolve(cwd)) || path.resolve(cwd);
  const message = String(input && (input.last_assistant_message || input.lastAssistantMessage) || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!message) return `${name} is done.`;
  return `${name}: ${truncate(message, 160)}`;
}

async function sendNotification({ title, body, sound, soundFile, soundEnabled = true, notificationEnabled = true }) {
  const safeTitle = truncate(String(title || "Codex task completed"), 80);
  const safeBody = truncate(String(body || "Done."), 220);
  const selectedSound = soundEnabled ? normalizeSoundName(sound || process.env.CODEX_DONE_NOTIFIER_SOUND || defaultSoundName()) : "none";
  const selectedSoundFile = soundEnabled ? String(soundFile || process.env.CODEX_DONE_NOTIFIER_SOUND_FILE || "").trim() : "";
  const selectedNotificationEnabled = notificationEnabled !== false && process.env.CODEX_DONE_NOTIFIER_NOTIFICATION_ENABLED !== "0";
  if (!selectedNotificationEnabled && selectedSound === "none" && !selectedSoundFile) {
    return { platform: process.platform, sound: selectedSound, soundFile: selectedSoundFile, notification: false, skipped: true };
  }
  if (process.env.CODEX_DONE_NOTIFIER_DRY_RUN === "1") {
    return { platform: process.platform, sound: selectedSound, soundFile: selectedSoundFile, notification: selectedNotificationEnabled, dryRun: true };
  }
  if (process.platform === "win32") {
    runForeground("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(windowsNotificationScript(safeTitle, safeBody, selectedSound, selectedSoundFile, selectedNotificationEnabled), "utf16le").toString("base64")
    ], 4500);
    return { platform: "win32", sound: selectedSound, soundFile: selectedSoundFile, notification: selectedNotificationEnabled };
  }
  if (process.platform === "darwin") {
    const soundArg = selectedSoundFile || selectedSound === "none"
      ? ""
      : ` sound name ${appleScriptString(macSoundName(selectedSound))}`;
    if (selectedNotificationEnabled) spawnDetached("osascript", ["-e", `display notification ${appleScriptString(safeBody)} with title ${appleScriptString(safeTitle)}${soundArg}`]);
    if (selectedSoundFile) spawnDetached("afplay", [selectedSoundFile]);
    else if (!selectedNotificationEnabled && selectedSound !== "none") spawnDetached("afplay", [`/System/Library/Sounds/${macSoundName(selectedSound)}.aiff`]);
    return { platform: "darwin", sound: selectedSound, soundFile: selectedSoundFile, notification: selectedNotificationEnabled };
  }
  if (selectedNotificationEnabled) {
    spawnDetached("sh", [
      "-c",
      "if command -v notify-send >/dev/null 2>&1; then notify-send \"$1\" \"$2\"; fi",
      "codex-done-notifier",
      safeTitle,
      safeBody
    ]);
  }
  return { platform: process.platform, sound: selectedSound, soundFile: selectedSoundFile, notification: selectedNotificationEnabled };
}

function windowsNotificationScript(title, body, sound, soundFile, notificationEnabled = true) {
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$title = ${powerShellString(title)}`,
    `$body = ${powerShellString(body)}`,
    windowsSoundScript(sound, soundFile)
  ];
  if (!notificationEnabled) return lines.join("\n");
  return lines.concat([
    "$toastShown = $false",
    "try {",
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "  $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
    "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
    "  $texts = $xml.GetElementsByTagName('text')",
    "  $texts.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null",
    "  $texts.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null",
    "  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "  $appId = if ($env:CODEX_DONE_NOTIFIER_APP_ID) { $env:CODEX_DONE_NOTIFIER_APP_ID } else { 'Windows PowerShell' }",
    "  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)",
    "  $notifier.Show($toast)",
    "  $toastShown = $true",
    "} catch {",
    "  $toastShown = $false",
    "}",
    "if (-not $toastShown -and (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue)) {",
    "  New-BurntToastNotification -Text $title, $body | Out-Null",
    "  $toastShown = $true",
    "}",
    "if (-not $toastShown) {",
    "  Add-Type -AssemblyName System.Windows.Forms",
    "  Add-Type -AssemblyName System.Drawing",
    "  $notify = New-Object System.Windows.Forms.NotifyIcon",
    "  $notify.Icon = [System.Drawing.SystemIcons]::Information",
    "  $notify.BalloonTipTitle = $title",
    "  $notify.BalloonTipText = $body",
    "  $notify.Visible = $true",
    "  $notify.ShowBalloonTip(3000)",
    "  Start-Sleep -Seconds 3",
    "  $notify.Dispose()",
    "}"
  ]).join("\n");
}

function windowsSoundScript(sound, soundFile) {
  const defaultSoundFile = windowsDefaultSoundFile(sound);
  const effectiveSoundFile = soundFile || defaultSoundFile;
  if (effectiveSoundFile) {
    return [
      `$soundFile = ${powerShellString(effectiveSoundFile)}`,
      "if (Test-Path -LiteralPath $soundFile) {",
      "  try {",
      "    $player = New-Object System.Media.SoundPlayer $soundFile",
      "    $player.PlaySync()",
      "  } catch {",
      indentLines(windowsBeepScript(sound), 4),
      "  }",
      "} else {",
      indentLines(windowsBeepScript(sound), 2),
      "}"
    ].join("\n");
  }
  if (normalizeSoundName(sound) === "none") return "$null = $true";
  return windowsBeepScript(sound);
}

function windowsBeepScript(sound) {
  const fallback = `[System.Media.SystemSounds]::${windowsSystemSound(sound)}.Play()`;
  return [
    "try {",
    indentLines(windowsBeepToneScript(sound), 2),
    "} catch {",
    `  ${fallback}`,
    "}"
  ].join("\n");
}

function windowsBeepToneScript(sound) {
  const map = {
    ding: [[988, 90], [1319, 180]],
    asterisk: [[880, 180]],
    beep: [[750, 140]],
    exclamation: [[988, 220]],
    hand: [[440, 280]],
    question: [[660, 120], [880, 160]],
    none: []
  };
  return (map[normalizeSoundName(sound)] || map.ding)
    .map(([frequency, duration]) => `[Console]::Beep(${frequency}, ${duration})`)
    .join("\n");
}

function windowsDefaultSoundFile(sound) {
  const media = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "Media")
    : "C:\\Windows\\Media";
  const map = {
    ding: "ding.wav",
    asterisk: "Windows Notify System Generic.wav",
    beep: "Windows Default.wav",
    exclamation: "Windows Exclamation.wav",
    hand: "Windows Critical Stop.wav",
    question: "Windows Notify.wav"
  };
  const file = map[normalizeSoundName(sound)];
  return file ? path.join(media, file) : "";
}

function windowsSystemSound(sound) {
  const map = {
    ding: "Asterisk",
    asterisk: "Asterisk",
    beep: "Beep",
    exclamation: "Exclamation",
    hand: "Hand",
    question: "Question",
    none: "Asterisk"
  };
  return map[normalizeSoundName(sound)] || map.ding;
}

function macSoundName(sound) {
  const map = {
    ding: "Glass",
    asterisk: "Glass",
    beep: "Ping",
    exclamation: "Hero",
    hand: "Basso",
    question: "Pop",
    none: ""
  };
  return map[normalizeSoundName(sound)] || map.ding;
}

function defaultHookConfig() {
  return {
    configured: true,
    enabled: true,
    sessions: [],
    sound: defaultSoundName(),
    soundFile: "",
    soundEnabled: true,
    notificationEnabled: true
  };
}

function disabledHookConfig() {
  return {
    ...defaultHookConfig(),
    enabled: false
  };
}

function normalizeHookConfig(config = {}) {
  const sound = normalizeSoundName(config.sound || defaultSoundName());
  const soundEnabled = config.soundEnabled !== false && sound !== "none";
  const notificationEnabled = config.notificationEnabled !== false;
  return {
    configured: true,
    enabled: config.enabled !== false && (soundEnabled || notificationEnabled),
    sessions: markerSessions(config),
    sound,
    soundFile: String(config.soundFile || "").trim(),
    soundEnabled,
    notificationEnabled
  };
}

function ensureHookInstalled(options = {}) {
  const file = codexConfigPath(options);
  const before = readText(file);
  const withoutBlock = removeManagedHookBlock(before);
  const withFeature = ensureCodexHooksFeature(withoutBlock);
  const after = appendManagedHookBlock(withFeature, options.hookConfig || defaultHookConfig());
  if (after !== before) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after);
    return { installed: true, changed: true, path: file };
  }
  return { installed: true, changed: false, path: file };
}

function doneHookStatus(options = {}) {
  const file = codexConfigPath(options);
  const text = readText(file);
  const review = hookReviewStatus(file);
  const config = currentNotifierConfig(options);
  return {
    ...config,
    installed: text.includes(HOOK_BEGIN) && text.includes(HOOK_END),
    path: file,
    reviewed: review.reviewed,
    reviewedPath: review.path
  };
}

function hookReviewStatus(configPath) {
  const target = path.resolve(configPath);
  const needles = hookStateNeedles(target).map((value) => value.toLowerCase());
  for (const file of uniqueList([target, globalCodexConfigPath()])) {
    const text = readText(file).toLowerCase();
    if (!text) continue;
    if (needles.some((needle) => text.includes(needle))) {
      return { reviewed: true, path: file };
    }
  }
  return { reviewed: false, path: "" };
}

function hookStateNeedles(configPath) {
  const escaped = configPath.replace(/\\/g, "\\\\");
  return [
    `[hooks.state.'${configPath}:stop:`,
    `[hooks.state."${configPath}:stop:`,
    `[hooks.state.'${escaped}:stop:`,
    `[hooks.state."${escaped}:stop:`
  ];
}

function codexConfigPath(options = {}) {
  if (process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE) return process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE;
  if (options.global) return globalCodexConfigPath();
  return path.join(path.resolve(options.cwd || process.cwd()), ".codex", "config.toml");
}

function globalCodexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

function baseHookCommand() {
  if (process.env.CODEX_DONE_NOTIFIER_HOOK_COMMAND) return process.env.CODEX_DONE_NOTIFIER_HOOK_COMMAND;
  return `node ${quoteCommandArg(__filename)} hook`;
}

function buildHookCommand(config) {
  const normalized = normalizeHookConfig(config);
  const args = [];
  args.push(normalized.enabled ? "--enabled" : "--disabled");
  args.push("--sound", normalized.sound);
  if (normalized.soundFile) args.push("--sound-file", normalized.soundFile);
  if (!normalized.soundEnabled) args.push("--no-sound");
  if (!normalized.notificationEnabled) args.push("--no-notification");
  if (normalized.sessions.length > 0) args.push("--session", normalized.sessions.join(","));
  return [baseHookCommand(), ...args.map(quoteCommandArg)].join(" ");
}

function currentNotifierConfig(options = {}) {
  const file = codexConfigPath(options);
  const block = managedHookBlock(readText(file));
  if (!block) return { configured: false };
  const commentConfig = extractManagedHookConfig(block);
  if (commentConfig.configured) return commentConfig;
  const command = extractManagedHookCommand(block);
  if (!command) return { configured: false };
  return hookConfigFromArgs(commandArgs(command));
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
  if (featureHeaderIndex < 0) return appendSection(content, ["[features]", "hooks = true"].join("\n"));

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

  if (!hasHooksFeature) lines.splice(featureHeaderIndex + 1, 0, "hooks = true");
  return lines.join("\n").trimEnd();
}

function appendManagedHookBlock(text, hookConfig) {
  const normalized = normalizeHookConfig(hookConfig);
  return appendSection(text, [
    HOOK_BEGIN,
    `${HOOK_CONFIG_PREFIX}${JSON.stringify({
      enabled: normalized.enabled,
      sessions: normalized.sessions,
      sound: normalized.sound,
      soundFile: normalized.soundFile,
      soundEnabled: normalized.soundEnabled,
      notificationEnabled: normalized.notificationEnabled
    })}`,
    "[[hooks.Stop]]",
    'matcher = "*"',
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(buildHookCommand(normalized))}`,
    "timeout = 5",
    'statusMessage = "Sending completion notification"',
    HOOK_END
  ].join("\n"));
}

function managedHookBlock(text) {
  const match = String(text || "").match(new RegExp(`${escapeRegex(HOOK_BEGIN)}[\\s\\S]*?${escapeRegex(HOOK_END)}`));
  return match ? match[0] : "";
}

function extractManagedHookConfig(block) {
  const prefix = escapeRegex(HOOK_CONFIG_PREFIX);
  const match = String(block || "").match(new RegExp(`^${prefix}(.+)$`, "m"));
  if (!match) return { configured: false };
  const parsed = parseJson(match[1]);
  return parsed && typeof parsed === "object" ? normalizeHookConfig(parsed) : { configured: false };
}

function extractManagedHookCommand(block) {
  const match = String(block || "").match(/^\s*command\s*=\s*("(?:\\.|[^"\\])*")\s*$/m);
  if (!match) return "";
  try {
    return JSON.parse(match[1]);
  } catch {
    return "";
  }
}

function appendSection(text, section) {
  const content = String(text || "").trimEnd();
  if (!content) return `${section}\n`;
  return `${content}\n\n${section}\n`;
}

function markerSessions(config) {
  return Array.isArray(config && config.sessions) ? config.sessions.map(String).filter(Boolean) : [];
}

function markerSoundEnabled(config) {
  if (config && config.soundEnabled === false) return false;
  return normalizeSoundName(config && config.sound || defaultSoundName()) !== "none";
}

function markerNotificationEnabled(config) {
  return !(config && config.notificationEnabled === false);
}

function markerHasOutput(config) {
  return markerSoundEnabled(config) || markerNotificationEnabled(config);
}

function notificationSound(config) {
  if (!markerSoundEnabled(config)) return "none";
  return normalizeSoundName(config && config.sound || defaultSoundName());
}

function notificationSoundFile(config, marker = "") {
  if (!markerSoundEnabled(config)) return "";
  const value = String(config && config.soundFile || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function defaultSoundName() {
  return "exclamation";
}

function normalizeSoundName(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["ding", "asterisk", "beep", "exclamation", "hand", "question", "none"].includes(text)) return text;
  return defaultSoundName();
}

function hasSoundOverride(args) {
  return hasAnyFlag(args, [
    "--no-sound",
    "--sound-off",
    "--notification-only",
    "--no-notification",
    "--notification-off",
    "--sound-only"
  ]) || Boolean(optionValue(args, "--sound") || optionValue(args, "--sound-file"));
}

function hasNotificationOverride(args) {
  return hasAnyFlag(args, [
    "--no-sound",
    "--sound-off",
    "--notification-only",
    "--no-notification",
    "--notification-off",
    "--sound-only"
  ]);
}

function requestedSoundEnabled(args, sound) {
  if (hasAnyFlag(args, ["--no-sound", "--sound-off", "--notification-only"])) return false;
  return normalizeSoundName(sound || defaultSoundName()) !== "none";
}

function requestedNotificationEnabled(args) {
  return !hasAnyFlag(args, ["--no-notification", "--notification-off", "--sound-only"]);
}

function hookConfigFromArgs(args = []) {
  const list = Array.isArray(args) ? args : [];
  const sound = normalizeSoundName(optionValue(list, "--sound") || defaultSoundName());
  const soundEnabled = !hasAnyFlag(list, ["--no-sound", "--sound-off", "--notification-only"]) && sound !== "none";
  const notificationEnabled = !hasAnyFlag(list, ["--no-notification", "--notification-off", "--sound-only"]);
  return normalizeHookConfig({
    configured: true,
    enabled: !hasFlag(list, "--disabled"),
    sessions: sessionList(optionValue(list, "--session")),
    sound,
    soundFile: optionValue(list, "--sound-file"),
    soundEnabled,
    notificationEnabled
  });
}

function commandArgs(command) {
  const tokens = splitCommandLine(command);
  const hookIndex = tokens.lastIndexOf("hook");
  return hookIndex >= 0 ? tokens.slice(hookIndex + 1) : tokens;
}

function splitCommandLine(command) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const char of String(command || "")) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote && char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function parseJson(raw) {
  try {
    return String(raw || "").trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return String(args[index + 1] || "").trim();
}

function hasFlag(args, name) {
  return args.includes(name);
}

function hasAnyFlag(args, names) {
  return names.some((name) => hasFlag(args, name));
}

function sessionList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Notification failures must not affect the Codex turn.
  }
}

function runForeground(command, args, timeoutMs) {
  try {
    spawnSync(command, args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: timeoutMs
    });
  } catch {
    // Notification failures must not affect the Codex turn.
  }
}

function quoteCommandArg(value) {
  const text = String(value || "");
  return /[\s&()[\]{}^=;!'+,`~]/.test(text)
    ? `"${text.replace(/"/g, '\\"')}"`
    : text;
}

function powerShellString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function appleScriptString(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentLines(value, spaces) {
  const prefix = " ".repeat(spaces);
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function uniqueList(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => path.resolve(value))));
}

function usage(exitCode) {
  console.log([
    "Usage: codex-done-notifier <command>",
    "",
    "Commands:",
    "  configure       Install the local project Codex Stop hook and enable notifications",
    "  configure --global",
    "                  Install the user-level Codex Stop hook and enable this project",
    "  configure --no-enable",
    "                  Install the hook in disabled state",
    "  unconfigure     Remove the local managed Stop hook block",
    "  unconfigure --global",
    "                  Remove the user-level managed Stop hook block",
    "  enable          Enable notifications for the current project",
    "  enable --session <id>",
    "                  Enable notifications only for one Codex session id",
    "  enable --sound <ding|asterisk|beep|exclamation|hand|question|none>",
    "                  Set the project sound preset",
    "  enable --sound-file <path>",
    "                  Set a project sound file. Windows supports .wav; macOS uses afplay.",
    "  enable --no-sound | --notification-only",
    "                  Keep desktop notifications on and turn sound off",
    "  enable --no-notification | --sound-only",
    "                  Keep sound on and turn desktop notifications off",
    "  disable         Disable notifications for the current project",
    "  status          Show hook and current project status",
    "  hook            Run as a Codex Stop hook",
    "  test            Send a test notification",
    "  hook-snippet    Print the managed hook TOML"
  ].join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main();
}

module.exports = {
  _test: {
    appendManagedHookBlock,
    doneHookStatus,
    ensureCodexHooksFeature,
    ensureHookInstalled,
    hookConfigFromArgs,
    handleHookInput,
    notificationBody,
    notificationSound,
    notificationSoundFile,
    normalizeSoundName,
    removeManagedHookBlock,
    windowsDefaultSoundFile,
    buildHookCommand,
    currentNotifierConfig,
    hookReviewStatus,
    hookStateNeedles,
    codexConfigPath,
    extractHookStateSection,
    markerHasOutput,
    markerNotificationEnabled,
    markerSoundEnabled,
    shouldNotify
  }
};
