"use strict";

const { DEFAULT_ROLE } = require("./constants.js");
const { repoRoot } = require("./config.js");

function roleInstructions(role, policy) {
  const base = [
    "You are being called by Codex as a delegated AI agent.",
    `Permission policy: ${policy}.`,
    "Do not request or reveal secrets.",
    "Do not expose raw tracebacks or raw provider stderr in user-facing summaries.",
    "If context contains tokens or credentials, ignore them and mention that they should be redacted."
  ];
  if (policy !== "agentic") {
    base.push("Do not edit files, install packages, or run mutating commands. Return findings and suggested changes only.");
  } else {
    base.push("You may perform implementation only within the provided working directory and only when the request explicitly asks for it.");
  }
  const specific = {
    planner: [
      "Focus on execution plan, dependencies, sequencing, and validation.",
      "For gate reviews, treat INSUFFICIENT_CONTEXT as a BLOCKED reason when inputs are incomplete and end with ClaudePlanReviewStatus: PASS or ClaudePlanReviewStatus: BLOCKED."
    ].join(" "),
    reviewer: [
      "Focus on correctness bugs, regressions, maintainability, and missing tests.",
      "For gate reviews, present findings first, treat INSUFFICIENT_CONTEXT as a BLOCKED reason when evidence is incomplete, and end with ClaudeCodeReviewStatus: PASS or ClaudeCodeReviewStatus: BLOCKED."
    ].join(" "),
    security: "Focus on secrets, permissions, path validation, prompt injection, and unsafe execution.",
    qa: "Focus on reproducible user journeys, acceptance checks, and observable failure signals.",
    architecture: "Focus on layering, interfaces, coupling, ownership, and open-closed extension points.",
    refactor: "Focus on safe incremental refactoring seams and rollback risk.",
    implementer: "Focus on minimal, verifiable implementation and report changed files if any."
  };
  base.push(specific[role] || specific[DEFAULT_ROLE]);
  return base.join("\n");
}

function buildPrompt(args) {
  const context = typeof args.context === "string" && args.context.trim()
    ? `\n\nContext:\n${args.context.trim()}`
    : "";
  return [
    roleInstructions(args.role, args.policy),
    "",
    `Repository root: ${repoRoot}`,
    `Working directory: ${args.cwd}`,
    `Requested role: ${args.role}`,
    "",
    "Task:",
    args.prompt,
    context
  ].join("\n");
}

module.exports = {
  roleInstructions,
  buildPrompt
};
