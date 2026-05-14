# Codex Done Notifier

Codex Done Notifier is a lightweight Codex `Stop` hook that plays a local sound
and shows a desktop notification when a Codex turn finishes.

Korean documentation: [README.ko.md](README.ko.md)

This is not an MCP server. It does not add model-visible tools and does not add
token cost. Codex runs it locally through the lifecycle hook system.

## Install

```powershell
npm install -g @chogwanghyung/codex-done-notifier
cd <project-dir>
codex-done-notifier configure
```

By default, `configure` updates only the current project's `.codex/config.toml`
and stores the notifier settings in the managed `Stop` hook command.

Use a user-level hook only when you want one hook available across projects:

```powershell
codex-done-notifier configure --global
```

## Install From This Repository

```powershell
git clone https://github.com/ChoGwangHyung/Codex-MCP.git
cd Codex-MCP
node .\codex-done-notifier\src\cli.js configure
```

From a repository checkout, replace `codex-done-notifier` in the examples below
with `node <repo>\codex-done-notifier\src\cli.js`.

After installing or changing hooks, existing Codex sessions should be restarted
or resumed once so they reload config.

Codex may ask you to review the hook once through `/hooks`. On Windows, if the
same project is later resumed with different path casing such as `D:\Project`
vs `d:\project`, run:

```powershell
codex-done-notifier trust
```

This records the current hook hash for the normal and lowercase path forms in
`~/.codex/config.toml`.

## Enable One Project

`configure` already enables the current project. Use `enable` later to turn
notifications back on after `disable`, or to enable a different project:

```powershell
cd <project-dir>
codex-done-notifier enable
```

This updates:

```text
.codex/config.toml
```

Set a project-specific sound preset:

```powershell
codex-done-notifier enable --sound exclamation
```

Supported presets are `ding`, `asterisk`, `beep`, `exclamation`, `hand`,
`question`, and `none`. The default sound is `exclamation`.

Set a project-specific sound file:

```powershell
codex-done-notifier enable --sound-file .codex\done.wav
```

On Windows, custom sound files use `System.Media.SoundPlayer`, so `.wav` is the
portable choice. On macOS, custom sound files are played with `afplay`.

Turn off only the sound while keeping desktop notifications:

```powershell
codex-done-notifier enable --no-sound
```

Turn off only the desktop notification while keeping sound:

```powershell
codex-done-notifier enable --no-notification
```

If both outputs are turned off, the project behaves as disabled. A later plain
`enable` turns both outputs back on. If only one output was off before a full
`disable`, a later plain `enable` restores that one-output-off preference.

Disable it:

```powershell
codex-done-notifier disable
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
| `configure --no-enable` | Install the hook in disabled state. |
| `unconfigure` | Remove the local managed hook block. |
| `unconfigure --global` | Remove the user-level managed hook block. |
| `enable` | Enable notifications for the current project. |
| `enable --session <id>` | Enable notifications for one Codex session id. |
| `enable --sound <preset>` | Set the current project's sound preset. |
| `enable --sound-file <path>` | Set the current project's sound file. |
| `enable --no-sound` or `enable --notification-only` | Turn off sound only. |
| `enable --no-notification` or `enable --sound-only` | Turn off desktop notifications only. |
| `disable` | Disable notifications for the current project. |
| `status` | Show hook and current project status. |
| `trust` | Record the current hook trust hash, including Windows path-case variants. |
| `test` | Send a test notification. |
| `hook-snippet` | Print the hook TOML snippet. |

## Hook Behavior

The hook reads the Codex hook JSON from stdin and checks:

- `CODEX_DONE_NOTIFIER_ENABLED=1`
- `CODEX_DONE_NOTIFIER_SESSION_IDS`
- or the managed hook options stored in `.codex/config.toml`

If none match, it exits quietly.

## Troubleshooting

Check the current project first:

```powershell
codex-done-notifier status
codex-done-notifier test
```

`status` should show `hook_installed: yes`, `hook_reviewed: yes`, and
`enabled_here: yes`. It also prints `hook_trust_status` and the current hook
hash. If the hook was installed or trusted after the Codex session was already
open, exit that session and resume it once so Codex reloads the hook config.

If Codex keeps asking to review the same Stop hook after resume, the most common
Windows cause is a path-casing mismatch in Codex's hook trust key. Run
`codex-done-notifier trust` from the project directory, then exit and resume the
session once.

If `test` prints `sent` but nothing appears, the hook is runnable and the issue
is usually the desktop notification environment: Windows Focus Assist, disabled
PowerShell/terminal notifications, or a silent system sound scheme. On Windows,
the notifier uses BurntToast when that module is available, otherwise it falls
back to a tray balloon. Sound presets use `[Console]::Beep` with a system sound
fallback, and a custom `.wav` can be set with `enable --sound-file`.
The default Windows `exclamation` preset first tries
`C:\Windows\Media\Windows Exclamation.wav`.

## Requirements

- Node.js 20 or newer.
- Codex hooks enabled.
- Windows: Windows Runtime toast notification, BurntToast when available, then
  tray balloon fallback, plus built-in `.wav`, `[Console]::Beep`, or a custom
  `.wav` file.
- macOS: `osascript` notification plus a system sound or `afplay` file.
- Linux: `notify-send` notification when available. Sound playback is not
  enabled by default.

## License

MIT. See [LICENSE](LICENSE).
