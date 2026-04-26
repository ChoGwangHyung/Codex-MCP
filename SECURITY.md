# Security

## Security Model

Codex-MCP is local-first: MCP servers run on the operator's machine and do not
open an inbound public HTTP service by default. This reduces exposure, but it
does not make the setup risk-free. Telegram bot tokens, provider CLI sessions,
allowlisted chat IDs, and console injection still require trusted local
machines and careful secret handling.

## Secrets

Do not commit bot tokens, API keys, chat IDs, allowlists, or runtime inbox files.
Keep Telegram settings in a project-local ignored file such as
`.codex/config.toml.env` and `.codex/config.toml.access.json`.

Before publishing, scan for token-like values:

```powershell
rg -uuu -n "\d{6,}:[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|github_pat_|gh[pousr]_" .
```

## Telegram Relay

The Telegram relay is intended for operator coordination. Only allowlist chats
you control. Windows console relay mode injects key events into a local Codex
TUI and should only be enabled on trusted machines.

## Telegram Permission Hooks

When the Telegram bridge is configured, it installs a user-level Codex
`PermissionRequest` hook by default. Any allowlisted approval chat can approve
or deny native Codex permission requests. Use a dedicated
`CODEX_TELEGRAM_APPROVAL_CHAT_IDS` value for trusted operators, keep timeout
behavior at the default `ask` unless you intentionally want fail-closed `deny`,
and do not allowlist chats you do not control. Set
`CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL=0` if you do not want the MCP
server to manage the user-level hook.

## Agentic Bridges

`codex-ai-bridge-mcp` defaults to advisory/read-only behavior. Agentic provider
execution must be explicitly enabled with environment variables and should only
be used inside trusted workspaces.

## Validation

Validation is recommended before publishing or after code changes. It is not a
runtime security boundary, and it is not required for normal local operation.
