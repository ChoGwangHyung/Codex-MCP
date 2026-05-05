# Codex Telegram Bridge MCP

Reusable MCP server for allowlisted Telegram communication.

Korean documentation: [README.ko.md](README.ko.md)

This bridge is an operator coordination tool for Codex sessions. It is not a
general-purpose Telegram bot framework.

## What It Provides

| Tool | Purpose |
| --- | --- |
| `telegram_send` | Send a message to an allowlisted Telegram chat. |
| `telegram_send_file` | Send any file type from a local path, URL, or Telegram file ID. |
| `telegram_send_photo` | Send a photo from a local path, URL, or Telegram file ID. |
| `telegram_send_document` | Send a file/document from a local path, URL, or Telegram file ID. |
| `telegram_wait_reply` | Wait for one reply from an allowlisted chat. |
| `telegram_ask` | Send a message and wait for one reply. |
| `telegram_inbox_read` | Read or consume messages captured by the receive monitor. |
| `telegram_monitor_status` | Inspect monitor offset, inbox size, and monitor errors. |
| `telegram_relay_status` | Inspect Telegram-to-Codex relay configuration and pending messages. |
| `telegram_approval_request` | Ask Telegram for an explicit workflow approval. |
| `telegram_bridge_health` | Check token, allowlist, and runtime health. |

The package also includes a Codex hook command:

| Command | Purpose |
| --- | --- |
| `codex-telegram-permission-hook` | Handle native Codex `PermissionRequest` approvals through Telegram. |

For `telegram_send`, `telegram_wait_reply`, `telegram_ask`, and media tools,
`chatId` may be omitted when exactly one Telegram chat is allowlisted.

## Requirements

- Node.js 20 or newer.
- A Telegram bot token from `@BotFather`.
- A Telegram chat that has already sent `/start` or another message to the bot.
- A Codex project configured to load this MCP server.
- Codex hooks enabled when using native permission approval.
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
# Telegram-origin messages ask Codex to send the result back through Telegram.
# Set to 0 to disable the injected reply contract.
CODEX_TELEGRAM_CODEX_REPLY_REQUIRED=1
# Optional native Codex permission approval:
# CODEX_TELEGRAM_APPROVAL_CHAT_IDS=<chat-id>
# CODEX_TELEGRAM_PERMISSION_TIMEOUT_MS=300000
# CODEX_TELEGRAM_PERMISSION_TIMEOUT_BEHAVIOR=ask
# CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED=1
# CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL=1
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
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js hook-snippet
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

## Media Sending

Use `telegram_send_file` for format-agnostic file delivery. It sends through
Telegram's document path, so extensions such as `.apk`, `.md`, `.txt`, `.png`,
`.jpeg`, `.zip`, and logs are handled the same way and preserve the original
file. `telegram_send_document` is kept as an equivalent explicit document tool.

Use `telegram_send_photo` only when you specifically want Telegram to render the
image as a photo in chat. It shares the same local upload preparation logic, but
uses Telegram's photo endpoint.

Each media tool accepts exactly one source:

- `path`: upload a local file from the machine running the MCP server.
- `url`: send a public HTTP(S) URL for Telegram to fetch.
- `fileId`: resend an existing Telegram `file_id`.

When there is exactly one allowlisted chat, `chatId` may be omitted.

Send any local file:

```json
{
  "path": "D:\\Projects\\app-release.apk",
  "caption": "Latest build"
}
```

Send a photo from a URL:

```json
{
  "url": "https://example.com/screenshot.png",
  "caption": "Latest screenshot"
}
```

Result:

```json
{
  "status": "sent",
  "type": "file",
  "source": "path",
  "chatId": "12345",
  "messageId": 77,
  "fileName": "app-release.apk",
  "fileSize": 123456,
  "timestamp": "2026-05-05T00:00:00.000Z"
}
```

Local uploads reject directories, missing files, and files over the bridge's
conservative local upload cap before contacting Telegram.

## Choice Questions

`telegram_ask` can send inline keyboard choices and wait for either a button
click or a text fallback reply. This is useful for flows such as Claude fallback
decisions:

```json
{
  "message": "Claude review is unavailable. Choose the next action.",
  "choices": [
    { "label": "진행", "value": "proceed" },
    { "label": "대기", "value": "wait" },
    { "label": "중단", "value": "stop" }
  ],
  "timeoutMs": 300000
}
```

When there is exactly one allowlisted chat, `chatId` may be omitted. The default
UX is button-based. If callback delivery fails or the client cannot use buttons,
typing the label or value still works as a fallback.

Selection result:

```json
{
  "status": "selected",
  "timeout": false,
  "selected_label": "진행",
  "selected_value": "proceed",
  "chatId": "12345",
  "messageId": 99,
  "userId": "777",
  "timestamp": "2026-04-26T00:00:00.000Z"
}
```

Timeout result:

```json
{
  "status": "timeout",
  "timeout": true,
  "chatId": "12345",
  "messageId": 99
}
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
- `CODEX_TELEGRAM_CODEX_REPLY_REQUIRED=1` is the default. Telegram-origin
  prompts include a short instruction to call `telegram_send` with the result.
  Set it to `0` if you want one-way relay only.
- `CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING=1` skips old inbox messages and pairing messages.
- If Codex app-server status is available, the relay uses it as an idle gate and retries while the target thread is busy.

Relayed prompts contain the Telegram `chatId` marker, the user's message text,
and, by default, a short `telegram_send` reply instruction. The MCP cannot read
Codex's final screen output by itself; this injected reply contract is how
Telegram-origin requests get their result back in Telegram.

Check relay state:

```text
telegram_relay_status
```

## Native Codex Permission Approval

Codex can call the bundled hook command whenever it is about to show a native
approval prompt. The hook sends the request to Telegram and returns Codex's
`allow` or `deny` decision from the Telegram reply.

When the MCP server starts and Telegram is fully configured, it automatically
installs a user-level Codex `PermissionRequest` hook into
`$CODEX_HOME/config.toml` or `%USERPROFILE%/.codex/config.toml`. Project
`.codex/config.toml` files are not modified. This makes the hook available to
existing Codex projects without per-project setup.

If the current Codex process loaded config before the hook was installed,
restart or resume Codex once. After that, MCP connection plus the user-level
hook is enough for native permission requests to go through Telegram.

Set `CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL=0` to disable automatic hook
installation. To inspect or manually install the same hook, print the snippet:

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js hook-snippet
```

The command prints a TOML snippet like this:

```toml
[features]
codex_hooks = true

[[hooks.PermissionRequest]]
matcher = "*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/codex-permission-telegram.js"
timeout = 330
statusMessage = "Waiting for Telegram approval"

[[hooks.PostToolUse]]
matcher = "*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/codex-permission-telegram.js"
timeout = 30
statusMessage = "Updating Telegram approval state"
```

If installed globally from npm, use the package binary:

```toml
[[hooks.PermissionRequest]]
matcher = "*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "codex-telegram-permission-hook"
timeout = 330
statusMessage = "Waiting for Telegram approval"

[[hooks.PostToolUse]]
matcher = "*"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "codex-telegram-permission-hook"
timeout = 30
statusMessage = "Updating Telegram approval state"
```

Behavior:

- The approval prompt runs for Codex `PermissionRequest` events, such as shell
  escalation, managed-network approval, `apply_patch`, and MCP tool approvals.
- When the MCP server starts with Telegram configured, it auto-installs the
  user-level hook by default, so connected Codex sessions send native permission
  requests to Telegram after restart/resume.
- The bundled `PostToolUse` hook updates the Telegram message when a request
  falls back to the CLI prompt and is later approved there. CLI denial is not
  observable from current Codex hook events because the tool does not run.
- Telegram shows `승인`, `항상 승인`, and `거부` inline buttons. The internal
  request code is kept in the callback payload and is not shown in the message
  body. Buttons are removed after the first accepted response.
- `항상 승인` stores a bridge-side approval for the same session, cwd, tool name,
  and exact tool input signature. It does not modify Codex's global permission
  configuration. Remove the Telegram runtime state file, or set
  `CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED=0`, to stop using stored always
  approvals.
- Text fallback still accepts approval words such as `approve`, `승인`, `deny`,
  or `거부` from the same allowlisted chat. It also accepts `always approve` or
  `항상 승인` for the same bridge-side always-approval behavior.
- If `CODEX_TELEGRAM_APPROVAL_CHAT_IDS` is set, requests go only to those
  allowlisted chats. Otherwise, requests go to all allowlisted chats.
- If Telegram times out, the default behavior is `ask`, which falls back to the
  normal Codex approval prompt. Set `CODEX_TELEGRAM_PERMISSION_TIMEOUT_BEHAVIOR=deny`
  to fail closed.
- Set `CODEX_TELEGRAM_PERMISSION_APPROVAL_ENABLED=0` to disable the hook without
  removing hook config.

The hook uses the same token, allowlist, and runtime files as the MCP server.
Set the Telegram env/access file paths in the Codex hook environment or in the
project-local `.codex/config.toml.env`.

## Workflow Approval Helper

For explicit agent workflows that need an approval step separate from native
Codex permissions, call:

```text
telegram_approval_request
```

The helper sends Telegram inline buttons for approve, always approve, and deny
responses.
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

## Multiple MCP Instances

Several Codex sessions can run this MCP server with the same bot token. The
bridge uses a token-scoped cross-process lock around Telegram `getUpdates`, and
a state-file lock around local state writes, so multiple monitors do not collide
with Telegram long polling or corrupt the runtime state file.

A Telegram update is still consumed once per bot token. If separate Codex
sessions use the same bot token but different runtime state files, only the
instance that receives an update will relay that specific message. Use the same
runtime state file for one shared relay target, or separate bot tokens/chats
when each session needs independent routing.

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
telegram_send_file
telegram_send_photo
telegram_send_document
telegram_wait_reply
telegram_ask
```

## License

MIT. See the repository root `LICENSE`.
