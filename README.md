# Codex MCP

Codex MCP is a small workspace of MCP servers for Codex operator workflows.
Each server is kept as an independent package so projects can enable only the
tools they need.

Korean documentation: [README.ko.md](README.ko.md)

## Included Packages

| Package | Description |
| --- | --- |
| `@chogwanghyung/codex-ai-bridge-mcp` | Calls Claude Code and Gemini CLI for bounded planning, review, QA, architecture, security, or implementation advice. |
| `@chogwanghyung/codex-telegram-bridge-mcp` | Sends and receives Telegram messages and files through allowlisted chats, supports workflow approvals, auto-installs a user-level hook for native Codex permission approvals, and can relay Telegram messages into an active Codex session. |
| `@chogwanghyung/codex-done-notifier` | Local Codex `Stop` hook that plays a sound and shows a desktop notification when selected Codex sessions finish. |

## Install

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp
npm install -g @chogwanghyung/codex-telegram-bridge-mcp
npm install -g @chogwanghyung/codex-done-notifier
```

To install all three packages at once:

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp @chogwanghyung/codex-telegram-bridge-mcp @chogwanghyung/codex-done-notifier
```

The packages are still versioned and configured independently, so projects can
enable only the tools or hooks they need.

## Layout

```text
Codex-MCP/
  codex-ai-bridge-mcp/
  codex-telegram-bridge-mcp/
  codex-done-notifier/
```

## Validate

```powershell
npm run check
```

Validation is a recommended smoke check before publishing or after editing. It
is not required for normal local runtime use.

## Security

Do not commit tokens, chat IDs, allowlists, or runtime inbox files. See
[SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
