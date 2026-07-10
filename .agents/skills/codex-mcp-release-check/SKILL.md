---
name: codex-mcp-release-check
description: Run the complete pre-release verification for this Codex-MCP monorepo. Use after changing an MCP server, hook, package metadata, README, license, or security guidance, and before committing, pushing, or publishing any package.
---

# Codex MCP Release Check

Run the repository's deterministic release checks and turn failures into a short blocker list. The script validates all workspaces, npm package contents, JSON-RPC initialization and `tools/list`, and accidental secrets or machine-specific content.

## Workflow

1. Run focused tests for the package being edited while iterating.
2. From the repository root, run `npm run release:check`.
3. Fix every failure and rerun the full command.
4. Inspect `git diff --check` and `git status --short` before versioning.
5. Bump only changed public packages, rerun the check, then commit, push, or publish only when explicitly requested.

## Command

```powershell
npm run release:check
```

To run the implementation directly:

```powershell
node .agents/skills/codex-mcp-release-check/scripts/release-check.js
```

## Release Rules

- Tests are intentionally excluded from npm tarballs.
- Package tarballs must include only `src`, required `scripts`, license, and bilingual READMEs.
- JSON-RPC smoke tests must initialize each MCP and return its expected public tools.
- Never weaken the secret scan to make a release pass. Replace the sensitive fixture or content.
- Do not treat a successful dry run as authorization to publish.

The implementation is in `scripts/release-check.js`.
