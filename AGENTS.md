# Codex-MCP Working Agreement

## Scope

- Keep changes inside this repository unless the user explicitly names another project.
- Treat each package as an independent public npm package. Preserve its MCP and CLI contracts.
- Keep runtime dependencies at zero unless a dependency removes substantial, demonstrated risk.

## Ownership

- The main agent owns all edits, version changes, commits, pushes, and publishes.
- This repository defines no custom subagent roles. Work it directly rather than
  adding roles that would only re-read what the main agent can already read.
- Never run this repository's own AI or Telegram bridge MCPs against itself from
  an automated role, and never delegate publishing.

## Reporting

- Report to the user in Korean unless asked otherwise. Code, comments, commit
  messages, and status tokens stay English.
- Scope tool output: read targeted line ranges, cap searches, and summarize
  evidence instead of pasting raw dumps.

## Engineering

- Prefer Node.js built-ins and the existing CommonJS style.
- Preserve user changes in a dirty worktree and avoid unrelated refactors.
- Add focused tests for concurrency, state persistence, hooks, JSON-RPC schemas, and failure reporting.
- Never commit bot tokens, chat IDs, provider credentials, runtime state, personal paths, or project-specific names.

## Verification

Run the narrow package check while editing, then run this before release:

```powershell
npm run release:check
```

Publishing requires an explicit user request. Version only packages whose published contents changed.
