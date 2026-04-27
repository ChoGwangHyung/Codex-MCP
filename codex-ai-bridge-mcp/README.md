# Codex AI Bridge MCP

Codex AI Bridge MCP lets Codex ask Claude Code and Gemini CLI for bounded
advisory work without mixing those tools into the main Codex process.

Korean documentation: [README.ko.md](README.ko.md)

## What It Provides

| Tool | Purpose |
| --- | --- |
| `claude_task` | Ask Claude Code for a one-shot advisory task. |
| `gemini_task` | Ask Gemini CLI for a one-shot advisory task. |
| `cross_review` | Ask Claude and Gemini in parallel and return both responses. |
| `ai_bridge_job` | Poll a background job returned by a long provider task. |
| `ai_bridge_health` | Check whether provider CLIs are available. |

Typical uses:

- Plan review before a large implementation.
- Final diff review after changes.
- Architecture or security review with read-only constraints.
- Parallel second opinions from Claude and Gemini.

This server intentionally does not include Telegram tools. Use
`codex-telegram-bridge-mcp` for notifications and approvals.

## Requirements

- Node.js 20 or newer.
- Claude Code CLI if `claude_task` is used.
- Gemini CLI if `gemini_task` is used.
- A Codex project with this MCP server configured.

## Codex Configuration

Add the server to a project `.codex/config.toml`:

```toml
[mcp_servers.codex-ai-bridge]
command = "node"
args = ["<Codex-MCP>/codex-ai-bridge-mcp/src/index.js"]

[mcp_servers.codex-ai-bridge.env]
CODEX_AI_BRIDGE_ROOT = "<ProjectRoot>"
CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS = "1"
# Optional provider defaults:
# CODEX_AI_BRIDGE_CLAUDE_MODEL = "<claude-model>"
# CODEX_AI_BRIDGE_CLAUDE_EFFORT = "high"
```

Use forward slashes or escaped backslashes on Windows.

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

## Claude Model And Effort

`claude_task` supports:

```json
{
  "model": "<claude-model>",
  "effort": "high"
}
```

Effort values:

```text
low, medium, high, xhigh, max
```

Precedence:

- Claude model: task `model` > `CODEX_AI_BRIDGE_CLAUDE_MODEL` > unset.
- Claude effort: task `effort` > `CODEX_AI_BRIDGE_CLAUDE_EFFORT` > unset.

Gemini tasks do not accept `effort`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `CODEX_AI_BRIDGE_ROOT` | Repository root used to constrain relative `cwd` values. |
| `CODEX_AI_BRIDGE_CLAUDE_COMMAND` | Override Claude CLI command. |
| `CODEX_AI_BRIDGE_CLAUDE_MODEL` | Default Claude model. |
| `CODEX_AI_BRIDGE_CLAUDE_EFFORT` | Default Claude effort. |
| `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` | Claude max turns. Use `1` for one-shot gates. |
| `CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS` | Hard provider timeout. Defaults to `0`, which leaves long jobs alive until the provider exits. |
| `CODEX_AI_BRIDGE_SYNC_BUDGET_MS` | Foreground wait before returning a background job id. Defaults to `100000` ms. Set to `0` to wait until the provider exits. |
| `CODEX_AI_BRIDGE_JOB_CHECK_MS` | Interval for updating running job liveness status. Defaults to `300000` ms. |
| `CODEX_AI_BRIDGE_JOB_TTL_MS` | How long completed in-memory jobs are retained. Defaults to one hour. |
| `CODEX_AI_BRIDGE_GEMINI_COMMAND` | Override Gemini CLI command. |
| `CODEX_AI_BRIDGE_GEMINI_SANDBOX` | Set to `1` to pass Gemini sandbox options. |
| `CODEX_AI_BRIDGE_ALLOW_AGENTIC` | Set to `1` to allow `agentic` policy. |
| `CODEX_AI_BRIDGE_PROVIDER_LOCK` | Defaults to enabled. Set to `0` to disable provider locks. |
| `CODEX_AI_BRIDGE_LOCK_SCOPE` | Defaults to `workspace`. Set to `global` for the old provider-wide lock behavior. |
| `CODEX_AI_BRIDGE_LOCK_DIR` | Override the cross-process provider lock directory. |
| `CODEX_AI_BRIDGE_LOCK_WAIT_MS` | Maximum time to wait for a provider lock. Defaults to 24 hours when no hard timeout is set. |
| `CODEX_AI_BRIDGE_LOCK_STALE_MS` | Age after which a provider lock is considered stale. |

Provider locks prevent multiple Codex sessions in the same workspace from
invoking the same external provider CLI at the same time. Different workspaces
use different lock keys by default, so two projects can ask Claude or Gemini at
the same time without one session spending its MCP tool budget waiting for the
other project. Active locks are heartbeated, dead owner processes are cleaned
up, and timed-out Windows provider calls terminate the process tree to avoid
leaving Claude/Gemini children running after the bridge releases its lock.

Long provider calls are controlled by a foreground sync budget, not by killing
the provider. If `syncBudgetMs` is `0`, the tool waits until the provider exits
and sends MCP progress notifications at the job check interval when the client
provides a progress token. If a positive `syncBudgetMs` is reached first, the
tool returns a `jobId` and the provider continues in the background. Poll it
with `ai_bridge_job`; running jobs include `lastCheckedAt`, `elapsedMs`, and the
check interval. Set `"background": true` to return a `jobId` immediately. Use
`timeoutMs` only when you want a hard provider kill deadline; `0` disables that
deadline.

## Example

```json
{
  "role": "reviewer",
  "policy": "advisory",
  "prompt": "Review the pending diff for correctness risks. Findings first.",
  "syncBudgetMs": 0
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

MIT. See the repository root `LICENSE`.
