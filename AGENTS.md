# Codex-MCP Working Agreement

## Scope

- Keep changes inside this repository unless the user explicitly names another project.
- Treat each package as an independent public npm package. Preserve its MCP and CLI contracts.
- Keep runtime dependencies at zero unless a dependency removes substantial, demonstrated risk.

## Ownership

- The main agent owns all edits, version changes, commits, pushes, and publishes.
- Use read-only subagents only for bounded exploration, review, or verification when parallel work is useful.
- Do not let subagents run this repository's AI or Telegram bridge MCPs. Do not delegate publishing.

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
