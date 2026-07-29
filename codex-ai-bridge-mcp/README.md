# Codex AI Bridge MCP

Codex AI Bridge MCP lets Codex ask Claude Code, Gemini CLI, and Antigravity CLI
for bounded advisory work without mixing those tools into the main Codex
process.

Korean documentation: [README.ko.md](README.ko.md)

## What It Provides

| Tool | Purpose |
| --- | --- |
| `claude_task` | Ask Claude Code for a one-shot advisory task. |
| `gemini_task` | Ask Gemini CLI for a one-shot advisory task. |
| `antigravity_task` | Ask Antigravity CLI for a one-shot advisory task. |
| `cross_review` | Ask Claude, Gemini, or Antigravity in parallel and return the selected responses. |
| `ai_bridge_job` | Poll a background job returned by a long provider task. |
| `ai_bridge_health` | Check whether provider CLIs are available. |

Typical uses:

- Plan review before a large implementation.
- Final diff review after changes.
- Architecture or security review with read-only constraints.
- Parallel second opinions from Claude, Gemini, and Antigravity.

This server intentionally does not include Telegram tools. Use
`@chogwanghyung/codex-telegram-bridge-mcp` for notifications and approvals.

## Requirements

- Node.js 20 or newer.
- Claude Code CLI if `claude_task` is used.
- Gemini CLI if `gemini_task` is used.
- Antigravity CLI (`agy`) if `antigravity_task` is used.
- A Codex project with this MCP server configured.

## Install

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp
```

The package exposes the `codex-ai-bridge-mcp` binary for Codex MCP config.

## Codex Configuration

Add the server to a project `.codex/config.toml`:

```toml
[mcp_servers.codex-ai-bridge]
command = "node"
args = ["<Codex-MCP>/codex-ai-bridge-mcp/src/index.js"]

[mcp_servers.codex-ai-bridge.env]
CODEX_AI_BRIDGE_ROOT = "<ProjectRoot>"
CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS = "4"
# Optional provider defaults:
# Claude: `model` selects the model; `effort` selects reasoning depth.
# CODEX_AI_BRIDGE_CLAUDE_MODEL = "<claude-model>"
# CODEX_AI_BRIDGE_CLAUDE_EFFORT = "max"
# Gemini: no bridge `effort`; choose the Gemini CLI model only when needed.
# CODEX_AI_BRIDGE_GEMINI_MODEL = "<gemini-model>"
# Antigravity: `model` selects a stable slug and `effort` is low/medium/high.
# Run `agy models` for the slugs available to the current account.
# CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL = "<antigravity-model>"
# CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT = "high"
# For long reviews in clients with strict MCP tool deadlines:
# CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS = "0"
# CODEX_AI_BRIDGE_SYNC_BUDGET_MS = "120000"
```

Use forward slashes or escaped backslashes on Windows.

Task `cwd` values are optional. If supplied, they must resolve to an existing
directory under `CODEX_AI_BRIDGE_ROOT`. Omit `cwd` to run the provider from the
project root. The bridge resolves symlinks and junctions before enforcing this
boundary.

If installed globally from npm, the MCP command can be the package binary:

```toml
[mcp_servers.codex-ai-bridge]
command = "codex-ai-bridge-mcp"
```

## Policies

Every task has a `policy`:

| Policy | Behavior |
| --- | --- |
| `advisory` | Default. Providers should not edit files or run mutating commands. |
| `workspace-read` | Read-only workspace analysis. |
| `agentic` | Allows implementation only when `CODEX_AI_BRIDGE_ALLOW_AGENTIC=1` is set. |

For non-agentic policies, the bridge adds provider instructions that disallow
file edits, package installation, and mutating shell work.

## Roles

Supported roles:

```text
planner, reviewer, security, qa, architecture, refactor, implementer
```

The role becomes part of the provider prompt so reviews stay focused.

## Provider Models, Effort, And Turns

`claude_task` supports:

```json
{
  "model": "<claude-model>",
  "effort": "high",
  "maxTurns": 4
}
```

Effort values:

```text
low, medium, high, xhigh, max
```

`cross_review` keeps provider controls unambiguous with `claudeEffort` and
`antigravityEffort`. The latter accepts only `low`, `medium`, or `high`.

Provider reasoning controls:

| Provider | MCP fields | Reasoning/intensity control | Notes |
| --- | --- | --- | --- |
| Claude Code | `model`, `effort`, `maxTurns` | `effort` controls reasoning depth. `maxTurns` controls Claude CLI continuation turns for one bridge call. | Use `effort: "max"` and `maxTurns: 4` for broad review gates. Use `maxTurns: 1` only for strict single-turn probes. |
| Gemini CLI | `model` | No bridge-level `effort`. Pick the Gemini model exposed by your Gemini CLI/account. | `maxTurns` is accepted for cross-provider schema compatibility but does not emit a Gemini argv flag. |
| Antigravity CLI | `model`, `effort` | `model` accepts a stable slug from `agy models`; `effort` accepts `low`, `medium`, or `high`. | `maxTurns` is accepted for cross-provider schema compatibility but does not emit an Antigravity argv flag. |

Precedence:

- Claude model: task `model` > `CODEX_AI_BRIDGE_CLAUDE_MODEL` > review preset
  alias `fable` (otherwise unset).
- Gemini model: task `model` > `CODEX_AI_BRIDGE_GEMINI_MODEL` > Gemini CLI default.
- Antigravity model: task `model` > `CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL` > Antigravity CLI default.
- Claude effort: task `effort` > `CODEX_AI_BRIDGE_CLAUDE_EFFORT` > unset.
- Antigravity effort: task `effort` > `CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT` >
  review preset default (`high`) > unset.
- Provider max turns: task `maxTurns` > review preset default (`4`) >
  `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` > policy default (`8` for agentic, `3`
  otherwise).

`maxTurns` controls the provider's internal continuation limit for one bridge
call where the provider supports it. Claude uses `--max-turns`. The current
Gemini CLI and Antigravity CLI do not expose an equivalent flag, so
`gemini_task` and `antigravity_task` accept the field for cross-provider request
compatibility but do not emit a provider argv flag for it. A one-shot review
gate usually means one bridge tool call, not necessarily `--max-turns 1`; wide
Fable/max reviews often need about `4`. Use `1` only for strict single-turn
probes.

Gemini tasks do not accept `effort`. Current Antigravity CLI releases expose
`--effort low|medium|high` independently of `--model`. Model availability can
still vary by account, plan, region, and CLI version. The authoritative local
command is `agy models`; pass one of the exact stable slugs it prints. For
example, a recent CLI returned:

```text
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

## Presets

Set `"preset": "review"` for the default long review profile. For Claude this
uses the rolling model alias `model: "fable"`, `effort: "max"`,
`timeoutMs: 900000`, and
`syncBudgetMs: 120000`, and `maxTurns: 4` unless those fields are explicitly
supplied. In `cross_review`, `maxTurns` is applied to the Claude leg and is
accepted by Gemini and Antigravity legs for schema compatibility. Use
`claudeEffort` or `antigravityEffort` to override each review leg.

Set `"preset": "quick"` for short questions. It applies `timeoutMs: 120000`,
`syncBudgetMs: 60000`, `effort: "low"` for Claude and Antigravity, and
`maxTurns: 2` for Claude. Without it a one-line question inherits the review
profile and blocks the foreground for the full two minute budget before handing
back a job id. Explicit fields always win over a preset.

## Result Size

Provider output is trimmed to `maxOutputChars` characters, `12000` by default.
An over-budget result keeps its head and tail with the omitted character count
in between, so a large answer does not sit in the transcript for the rest of the
task. Pass `"maxOutputChars": 0` to disable trimming for one call, or set
`CODEX_AI_BRIDGE_MAX_RESULT_CHARS` to change the default. Failure reports trim
each of stdout, stderr, and the provider log independently and much harder,
since they exist to diagnose rather than to reproduce a run.

## Antigravity CLI

`antigravity_task` writes the full provider prompt to stdin. Current Antigravity
CLI releases detect piped stdin and enter print mode without a `-p` argument.
It also passes an isolated temporary `--log-file` and `--print-timeout` so
Antigravity print mode has a timeout aligned with the bridge hard timeout. If
`timeoutMs` is positive, the print timeout is derived from that value. If
`timeoutMs` is `0`, the default print timeout is `15m` unless
`CODEX_AI_BRIDGE_ANTIGRAVITY_PRINT_TIMEOUT` is set.

Antigravity 1.0.7 on Windows was observed completing print mode with exit code `0` while
leaving stdout empty. To make MCP results usable, the bridge asks Antigravity to
wrap its final answer in per-call capture markers and, when stdout is empty,
recovers that answer from Antigravity's local conversation store. If capture
fails, the bridge reports a provider failure and includes the Antigravity log
tail.

Antigravity print mode can try to use workspace tools even for short prompts.
For stability, `antigravity_task` instructs Antigravity not to use tools,
shell commands, workspace search, file reads, browser actions, MCP calls, or
subagents. Treat it as a prompt/context review provider: include the diff,
file excerpts, screenshots converted to text, or other evidence in `prompt` or
`context`.

`ai_bridge_health` checks that `agy --version` works; it does not prove that
Antigravity OAuth is logged in. Run a small `antigravity_task` smoke call after
installing or re-authenticating Antigravity CLI.

For non-agentic policies, Antigravity runs with both `--mode plan` and
`--sandbox` by default.
Set `CODEX_AI_BRIDGE_ANTIGRAVITY_SANDBOX=0` only if you intentionally want to
disable that default. Agentic mode never auto-approves Antigravity permissions
unless both `CODEX_AI_BRIDGE_ALLOW_AGENTIC=1` and
`CODEX_AI_BRIDGE_ANTIGRAVITY_DANGEROUS_SKIP_PERMISSIONS=1` are set.

If you want long reviews without a hard provider kill deadline, explicitly pass
`"timeoutMs": 0` or set `CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS=0` and omit the
`preset` field. Keep `syncBudgetMs` positive, for example `120000`, so the MCP
tool can return a `jobId` and let you poll with `ai_bridge_job`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `CODEX_AI_BRIDGE_ROOT` | Repository root used to constrain relative `cwd` values. |
| `CODEX_AI_BRIDGE_CLAUDE_COMMAND` | Override Claude CLI command. |
| `CODEX_AI_BRIDGE_CLAUDE_MODEL` | Default Claude model. Pair with `CODEX_AI_BRIDGE_CLAUDE_EFFORT` when you want to control reasoning depth. |
| `CODEX_AI_BRIDGE_CLAUDE_EFFORT` | Default Claude-only reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` | Default Claude CLI internal turn limit. This is not the number of bridge calls. Use `4` for broad one-call review gates; use `1` only for strict single-turn probes. |
| `CODEX_AI_BRIDGE_CLAUDE_PERMISSION_MODE` | Agentic Claude permission mode. Defaults to `acceptEdits`; non-agentic calls always use `plan`. |
| `CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS` | Hard provider timeout. Defaults to `900000` ms. Set to `0` to disable the hard timeout. |
| `CODEX_AI_BRIDGE_SYNC_BUDGET_MS` | Foreground wait before returning a background job id. Defaults to `120000` ms. Set to `0` to wait until the provider exits. |
| `CODEX_AI_BRIDGE_MAX_RESULT_CHARS` | Default `maxOutputChars` for provider results. Defaults to `12000`. Set to `0` to return untrimmed output. |
| `CODEX_AI_BRIDGE_JOB_CHECK_MS` | Interval for updating the in-memory job heartbeat timestamp and MCP progress notification. Defaults to `300000` ms. It is not a provider health probe. |
| `CODEX_AI_BRIDGE_JOB_TTL_MS` | How long completed in-memory jobs are retained. Defaults to one hour. |
| `CODEX_AI_BRIDGE_GEMINI_COMMAND` | Override Gemini CLI command. |
| `CODEX_AI_BRIDGE_GEMINI_MODEL` | Default Gemini model passed as `--model` unless the tool call supplies `model`. Gemini has no bridge-level `effort`; choose model capability instead. |
| `CODEX_AI_BRIDGE_GEMINI_SANDBOX` | Set to `1` to pass Gemini sandbox options. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_COMMAND` | Override Antigravity CLI command. `AGY_COMMAND` and `ANTIGRAVITY_COMMAND` are also accepted. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_MODEL` | Default Antigravity model slug passed as `--model` unless the tool call supplies `model`. Use an exact value from `agy models`. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_EFFORT` | Default Antigravity effort: `low`, `medium`, or `high`. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_PRINT_TIMEOUT` | Override the `agy --print-timeout` value, for example `15m` or `900s`. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_SANDBOX` | Defaults to enabled for non-agentic Antigravity calls. Set to `0` to disable or `1` to force it. |
| `CODEX_AI_BRIDGE_ANTIGRAVITY_DANGEROUS_SKIP_PERMISSIONS` | Set to `1` to pass `--dangerously-skip-permissions` only for explicitly enabled `agentic` calls. |
| `CODEX_AI_BRIDGE_ALLOW_AGENTIC` | Set to `1` to allow `agentic` policy. |
| `CODEX_AI_BRIDGE_PROVIDER_LOCK` | Defaults to enabled. Set to `0` to disable provider locks. |
| `CODEX_AI_BRIDGE_LOCK_SCOPE` | Defaults to `workspace`. Set to `global` for the old provider-wide lock behavior. |
| `CODEX_AI_BRIDGE_LOCK_DIR` | Override the cross-process provider lock directory. |
| `CODEX_AI_BRIDGE_LOCK_WAIT_MS` | Maximum time to wait for a provider lock. Defaults to 24 hours when no hard timeout is set. |
| `CODEX_AI_BRIDGE_LOCK_STALE_MS` | Age after which a provider lock is considered stale. |

Provider locks prevent multiple Codex sessions in the same workspace from
invoking the same external provider CLI at the same time. Different workspaces
use different lock keys by default, so two projects can ask Claude, Gemini, or
Antigravity at the same time without one session spending its MCP tool budget
waiting for the other project. Workspace lock paths are canonicalized on
Windows, including path case, so the same workspace cannot accidentally get
two lock keys. Active locks are heartbeated, dead owner
processes are cleaned up, and timed-out calls terminate the provider process
tree. The MCP server also terminates active provider children during SIGINT or
SIGTERM shutdown before exiting.

Long provider calls are controlled by a foreground sync budget, not by killing
the provider. `timeoutMs` is a hard provider kill deadline; it is not the normal
response wait time. If `syncBudgetMs` is `0`, the tool waits until the provider
exits and sends MCP progress notifications at the job check interval when the
client provides a progress token. If a positive `syncBudgetMs` is reached first,
the tool returns a `jobId` and the provider continues in the background. Poll it
with `ai_bridge_job`; running jobs include queue/provider state,
`lastCheckedAt`, `elapsedMs`, the heartbeat interval, and the remaining hard
timeout. The hard-timeout countdown starts only after the provider process
launches, not while waiting for a provider lock. Completed jobs report a
machine-readable `status` of `completed`, `failed`, or `timeout`, plus provider
PID and elapsed time when available. Jobs are kept in the current MCP process;
restarting that MCP loses its background job registry. When `timeoutMs > 0` and
`syncBudgetMs >= timeoutMs`, the bridge automatically lowers `syncBudgetMs` and
adds a warning so the returned `jobId` still has time to be polled before the
hard timeout.

Avoid passing the same positive value for `timeoutMs` and `syncBudgetMs`, such
as `240000` and `240000`. That makes the foreground budget end at the same time
as the hard kill deadline. For long Claude Fable/max reviews, prefer either
`timeoutMs: 900000, syncBudgetMs: 120000` or `timeoutMs: 0, syncBudgetMs:
120000`. Set `"background": true` to return a `jobId` immediately.

When a provider command fails, the failure output includes the working
directory and actual `argv` used to launch the provider. Common credential
flags in that argv are redacted. This makes settings
such as Claude `--max-turns` visible in the error report. It also shows when a
provider, such as the current Gemini CLI, has no corresponding argv flag.

## Example

```json
{
  "preset": "review",
  "maxTurns": 4,
  "role": "reviewer",
  "policy": "advisory",
  "prompt": "Review the pending diff for correctness risks. Findings first."
}
```

If that call returns a background job id, poll it with:

```json
{
  "jobId": "claude-..."
}
```

## Validation

```powershell
npm run check
```

Validation is recommended before publishing or after editing. It is not
required for normal local runtime use.

At runtime, call:

```text
ai_bridge_health
```

## Security Notes

- Do not include secrets in prompts.
- The bridge redacts common token patterns from provider output.
- Keep `agentic` disabled unless you intentionally want provider-side edits.

## License

MIT. See [LICENSE](LICENSE).
