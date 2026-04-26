"use strict";

function sanitize(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_BOT_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GOOGLE_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED_SLACK_TOKEN]")
    .trim();
}

function stderrSummary(stderr) {
  const clean = sanitize(stderr);
  if (!clean) return "";
  if (process.env.CODEX_AI_BRIDGE_DEBUG === "1") return clean.slice(-4000);
  return clean.split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
}

module.exports = {
  sanitize,
  stderrSummary
};
