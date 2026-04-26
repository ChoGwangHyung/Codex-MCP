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
| `CODEX_AI_BRIDGE_GEMINI_COMMAND` | Override Gemini CLI command. |
| `CODEX_AI_BRIDGE_GEMINI_SANDBOX` | Set to `1` to pass Gemini sandbox options. |
| `CODEX_AI_BRIDGE_ALLOW_AGENTIC` | Set to `1` to allow `agentic` policy. |

## Example

```json
{
  "role": "reviewer",
  "policy": "advisory",
  "prompt": "Review the pending diff for correctness risks. Findings first."
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
