# Codex Done Notifier

Codex Done Notifier is a lightweight Codex `Stop` hook that plays a local sound
and shows a desktop notification when a Codex turn finishes.

Korean documentation: [README.ko.md](README.ko.md)

This is not an MCP server. It does not add model-visible tools and does not add
token cost. Codex runs it locally through the lifecycle hook system.

## Install From This Repository

```powershell
git clone https://github.com/ChoGwangHyung/Codex-MCP.git
cd Codex-MCP
node .\codex-done-notifier\src\cli.js configure
```

By default, `configure` updates only the current project's `.codex/config.toml`
and also enables notifications for that project by creating
`.codex/notify-on-stop`.

Use a user-level hook only when you want one hook available across projects:

```powershell
node .\codex-done-notifier\src\cli.js configure --global
```

If installed globally later, the same commands are available as:

```powershell
codex-done-notifier configure
```

After installing or changing hooks, existing Codex sessions should be restarted
or resumed once so they reload config.

## Enable One Project

`configure` already enables the current project. Use `enable` later to turn
notifications back on after `disable`, or to enable a different project:

```powershell
cd D:\Projects\SomeProject
node D:\Projects\MCP\Codex-MCP\codex-done-notifier\src\cli.js enable
```

This creates:

```text
.codex/notify-on-stop
```

Disable it:

```powershell
node D:\Projects\MCP\Codex-MCP\codex-done-notifier\src\cli.js disable
```

## Enable One Session

For one shell-launched Codex session only, set an environment variable before
starting or resuming Codex:

```powershell
$env:CODEX_DONE_NOTIFIER_ENABLED = "1"
codex resume
```

For a known Codex session id, use:

```powershell
codex-done-notifier enable --session <session-id>
```

or:

```powershell
$env:CODEX_DONE_NOTIFIER_SESSION_IDS = "<session-id>"
codex resume
```

## Commands

| Command | Purpose |
| --- | --- |
| `configure` | Install the local project Codex `Stop` hook and enable notifications. |
| `configure --global` | Install the user-level Codex `Stop` hook and enable the current project. |
| `configure --no-enable` | Install the hook without creating the project marker. |
| `unconfigure` | Remove the local managed hook block. |
| `unconfigure --global` | Remove the user-level managed hook block. |
| `enable` | Enable notifications for the current project. |
| `enable --session <id>` | Enable notifications for one Codex session id. |
| `disable` | Disable notifications for the current project. |
| `status` | Show hook and current project status. |
| `test` | Send a test notification. |
| `hook-snippet` | Print the hook TOML snippet. |

## Hook Behavior

The hook reads the Codex hook JSON from stdin and checks:

- `CODEX_DONE_NOTIFIER_ENABLED=1`
- `CODEX_DONE_NOTIFIER_SESSION_IDS`
- or a `.codex/notify-on-stop` marker in the current directory or a parent
  directory

If none match, it exits quietly.

## Requirements

- Node.js 20 or newer.
- Codex hooks enabled.
- Windows is the primary supported notification target. macOS uses
  `osascript`; Linux attempts `notify-send` when available.

## License

MIT. See [LICENSE](LICENSE).
