"use strict";

const childProcess = require("node:child_process");

function normalizeTimeout(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 900000) {
    throw new Error("timeoutMs is outside the supported range");
  }
  return parsed;
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function singleLine(value) {
  return String(value || "").replace(/\r?\n/g, "\\n").trim();
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function parseJsonRows(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseBrokerCommandLine(commandLine) {
  return {
    endpoint: unquoteCommandArg(matchCommandArg(commandLine, "endpoint")),
    cwd: unquoteCommandArg(matchCommandArg(commandLine, "cwd"))
  };
}

function matchCommandArg(commandLine, name) {
  const pattern = new RegExp(`--${name}\\s+("[^"]+"|'[^']+'|\\S+)`);
  const match = pattern.exec(String(commandLine || ""));
  return match ? match[1] : "";
}

function unquoteCommandArg(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_BOT_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED_SLACK_TOKEN]")
    .trim();
}

function maskToken(token) {
  const text = String(token || "");
  if (!text) return "not set";
  const prefix = text.slice(0, Math.min(10, text.length));
  return `${prefix}...`;
}

function execFileText(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "exec failed").trim()));
        return;
      }
      resolve(stdout || "");
    });
  });
}

module.exports = {
  normalizeTimeout,
  normalizeInteger,
  singleLine,
  normalizePath,
  parseJsonRows,
  parseBrokerCommandLine,
  delay,
  sanitize,
  maskToken,
  execFileText
};
