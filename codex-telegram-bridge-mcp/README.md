# Codex Telegram Bridge MCP

Reusable MCP server for allowlisted Telegram communication.

Korean documentation: [README.ko.md](README.ko.md)

This bridge is an operator coordination tool for Codex sessions. It is not a
general-purpose Telegram bot framework.

## What It Provides

| Tool | Purpose |
| --- | --- |
| `telegram_send` | Send a message to an allowlisted Telegram chat. |
| `telegram_wait_reply` | Wait for one reply from an allowlisted chat. |
| `telegram_ask` | Send a message and wait for one reply. |
| `telegram_inbox_read` | Read or consume messages captured by the receive monitor. |
| `telegram_monitor_status` | Inspect monitor offset, inbox size, and monitor errors. |
| `telegram_relay_status` | Inspect Telegram-to-Codex relay configuration and pending messages. |
| `telegram_approval_request` | Ask Telegram for an explicit workflow approval. |
| `telegram_bridge_health` | Check token, allowlist, and runtime health. |

## Requirements

- Node.js 20 or newer.
- A Telegram bot token from `@BotFather`.
- A Telegram chat that has already sent `/start` or another message to the bot.
- A Codex project configured to load this MCP server.
- Core Telegram tools run anywhere Node.js runs. Console relay mode uses bundled
  Windows PowerShell helpers; use `app-server` mode or disable relay on other
  platforms.

Telegram bots cannot DM a user first. Pairing therefore starts with a user
opening the bot or pressing a deep-link Start button.

## Repository Layout

```text
codex-telegram-bridge-mcp/
├─ src/                         # MCP server, Telegram monitor, relay modules
├─ scripts/                     # Pairing helper and Windows console relay helpers
├─ README.md
└─ README.ko.md
```

## Codex Configuration

Add this server to the target project's `.codex/config.toml`:

```toml
[mcp_servers.codex-telegram-bridge]
command = "node"
args = ["<Codex-MCP>/codex-telegram-bridge-mcp/src/index.js"]

[mcp_servers.codex-telegram-bridge.env]
CODEX_TELEGRAM_BRIDGE_ENV_FILE = "<ProjectRoot>/.codex/config.toml.env"
CODEX_TELEGRAM_BRIDGE_ACCESS_FILE = "<ProjectRoot>/.codex/config.toml.access.json"
CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR = "<ProjectRoot>/.codex/telegram-runtime"
```

Keep live secrets out of `.codex/config.toml`. Put project-specific runtime
settings in `.codex/config.toml.env` and gitignore it:

```dotenv
CODEX_TELEGRAM_BRIDGE_ENABLED=1
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_CHAT_IDS=<chat-id>
CODEX_TELEGRAM_CODEX_RELAY_MODE=console
CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING=1
CODEX_TELEGRAM_CODEX_SUBMIT_DELAY_MS=150
```

Commit only a safe `.codex/config.toml.env.example` file.

If installed globally from npm, the MCP command can be the package binary:

```toml
[mcp_servers.codex-telegram-bridge]
command = "codex-telegram-bridge-mcp"
```

## Pairing Flow

Clipboard setup:

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js token-clipboard
```

The command reads the BotFather token from the local clipboard, saves it without
printing the token, and creates a short pairing code plus a Telegram deep link.

Open the printed `pair_link`, press Start in Telegram, then pair:

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js pair <code>
```

The script checks recent Telegram updates for `/start <code>` or the raw code,
extracts `message.chat.id`, adds it to the allowlist, and removes the pending
pairing code.

If exactly one pending code exists, `pair` can be run without an argument.

## Configuration Commands

Use the configure script directly:

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js status
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js token-clipboard
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js pair <code>
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js discover
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js allow <chat-id>
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js remove <chat-id>
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js policy allowlist
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js policy disabled
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js clear
```

After token or allowlist changes, restart or resume Codex so the MCP server
reloads the saved environment and access files.

## Automatic Receive Monitor

When enabled and configured, the server starts a Telegram `getUpdates` monitor.
It stores allowlisted text messages in a capped runtime inbox, advances a shared
offset, and ignores non-allowlisted chats.

Read captured messages:

```text
telegram_inbox_read
```

Read and consume messages:

```json
{
  "chatId": "<chat-id>",
  "consume": true
}
```

Check monitor state:

```text
telegram_monitor_status
```

## Telegram-To-Codex Relay

When the bridge is configured, allowlisted Telegram messages are relayed into
the active Codex session by default. Console mode is the default on Windows:

```dotenv
CODEX_TELEGRAM_CODEX_RELAY_MODE=console
```

Supported relay modes:

| Mode | Use Case |
| --- | --- |
| `console` | Windows Codex TUI sessions. Injects text and Enter into the target console. |
| `app-server` | Codex app-server streams. Useful only when the client is connected to that stream. |

Console relay details:

- The bridge auto-detects a Codex console ancestor when possible.
- `CODEX_TELEGRAM_CODEX_CONSOLE_PID` can explicitly select the target console.
- `CODEX_TELEGRAM_CODEX_SUBMIT_DELAY_MS` delays the Enter key after text input.
- `CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING=1` skips old inbox messages and pairing messages.
- If Codex app-server status is available, the relay uses it as an idle gate and retries while the target thread is busy.

Relayed prompts instruct Codex to call `telegram_send` to the same `chatId`
before considering the task complete.

Check relay state:

```text
telegram_relay_status
```

## Approval Helper

MCP servers cannot replace native Codex permission prompts. This bridge provides
an explicit workflow helper only:

```text
telegram_approval_request
```

Connecting this MCP server does not automatically forward native Codex approval
prompts to Telegram. An agent or workflow must call `telegram_approval_request`
explicitly.

The helper sends Telegram quick-reply buttons for approve and deny responses.
Use it only in workflows that deliberately call the tool.

## State Files

Project-local state:

```text
<project>/.codex/
├─ config.toml
├─ config.toml.env
├─ config.toml.env.example
├─ config.toml.access.json
└─ telegram-runtime/
```

User-local fallback:

```text
%USERPROFILE%/.codex/channels/telegram/
├─ .env
└─ access.json
```

Access JSON stores:

- `allowFrom`: allowlisted Telegram chat IDs.
- `pending`: temporary pairing codes.
- `dmPolicy`: `allowlist` or `disabled`.

## Security Notes

- The bridge is local-first and does not expose an inbound public service by
  default, but Telegram tokens and allowlisted chats still need protection.
- Default access policy is `allowlist`.
- Pairing codes expire after 10 minutes by default.
- Pairing succeeds only when a recent Telegram update contains the matching code.
- Telegram messages cannot approve their own chat IDs or mutate bridge policy.
- MCP tools can send to or wait on allowlisted chats only.
- Common token formats are sanitized from user-facing errors.
- Prefer `token-clipboard`; pasting a token into chat may leave it in conversation history.
- Never commit live bot tokens, chat IDs, access files, or runtime inbox files.

## Validation

```powershell
cd <Codex-MCP>/codex-telegram-bridge-mcp
npm run check
node scripts/telegram-configure.js status
```

Validation is recommended before publishing or after editing. It is not
required for normal local runtime use.

In Codex, confirm these tools are available:

```text
telegram_bridge_health
telegram_monitor_status
telegram_relay_status
telegram_send
telegram_wait_reply
telegram_ask
```

## License

MIT. See the repository root `LICENSE`.
