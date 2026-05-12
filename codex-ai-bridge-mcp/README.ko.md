# Codex AI Bridge MCP

Codex AI Bridge MCP는 Codex가 Claude Code와 Gemini CLI에 제한된 범위의
자문 작업을 요청할 수 있게 해주는 MCP 서버입니다. Claude/Gemini를 메인
Codex 프로세스에 섞지 않고, 계획·리뷰·QA 같은 보조 판단을 분리해서
사용하는 목적입니다.

기본 영어 문서: [README.md](README.md)

## 제공 도구

| Tool | 목적 |
| --- | --- |
| `claude_task` | Claude Code에 one-shot 자문 작업을 요청합니다. |
| `gemini_task` | Gemini CLI에 one-shot 자문 작업을 요청합니다. |
| `cross_review` | Claude와 Gemini를 병렬 호출하고 두 결과를 함께 반환합니다. |
| `ai_bridge_job` | 오래 걸리는 provider 작업이 반환한 background job을 조회합니다. |
| `ai_bridge_health` | provider CLI 사용 가능 여부를 확인합니다. |

주요 사용 예:

- 큰 구현 전 Plan Gate 리뷰.
- 변경 후 최종 diff 리뷰.
- 읽기 전용 아키텍처·보안 리뷰.
- Claude/Gemini 병렬 second opinion.

Telegram 도구는 의도적으로 포함하지 않았습니다. 알림과 승인은
`@chogwanghyung/codex-telegram-bridge-mcp`를 사용하세요.

## 요구 사항

- Node.js 20 이상.
- `claude_task`를 쓰려면 Claude Code CLI.
- `gemini_task`를 쓰려면 Gemini CLI.
- 이 MCP 서버가 등록된 Codex 프로젝트.

## 설치

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp
```

패키지는 Codex MCP config에서 사용할 `codex-ai-bridge-mcp` binary를 제공합니다.

## Codex 설정

프로젝트 `.codex/config.toml`에 추가합니다.

```toml
[mcp_servers.codex-ai-bridge]
command = "node"
args = ["<Codex-MCP>/codex-ai-bridge-mcp/src/index.js"]

[mcp_servers.codex-ai-bridge.env]
CODEX_AI_BRIDGE_ROOT = "<ProjectRoot>"
CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS = "4"
# 선택 provider 기본값:
# CODEX_AI_BRIDGE_CLAUDE_MODEL = "<claude-model>"
# CODEX_AI_BRIDGE_CLAUDE_EFFORT = "high"
# MCP tool deadline이 엄격한 client에서 긴 리뷰를 돌릴 때:
# CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS = "0"
# CODEX_AI_BRIDGE_SYNC_BUDGET_MS = "120000"
```

Windows에서는 forward slash 또는 escape된 backslash를 사용하세요.

작업별 `cwd`는 선택값입니다. 지정할 경우 `CODEX_AI_BRIDGE_ROOT` 아래의 실제
존재하는 디렉터리로 resolve되어야 합니다. 애매하면 `cwd`를 생략해 project root에서
provider를 실행하세요.

npm global 설치로 사용할 경우 MCP command에 package binary를 지정할 수 있습니다.

```toml
[mcp_servers.codex-ai-bridge]
command = "codex-ai-bridge-mcp"
```

## 정책

각 작업에는 `policy`가 있습니다.

| Policy | 동작 |
| --- | --- |
| `advisory` | 기본값입니다. 파일 수정이나 mutating command 없이 자문만 수행합니다. |
| `workspace-read` | 워크스페이스 읽기 전용 분석입니다. |
| `agentic` | `CODEX_AI_BRIDGE_ALLOW_AGENTIC=1`일 때만 구현 작업을 허용합니다. |

비-agentic 정책에서는 provider 프롬프트에 파일 수정, 패키지 설치,
mutating shell 작업 금지 지시가 추가됩니다.

## 역할

지원 역할:

```text
planner, reviewer, security, qa, architecture, refactor, implementer
```

역할은 provider 프롬프트에 포함되어 리뷰 초점을 좁히는 데 사용됩니다.

## Claude 모델, effort, turns

`claude_task`는 다음 인자를 지원합니다.

```json
{
  "model": "<claude-model>",
  "effort": "high",
  "maxTurns": 4
}
```

Effort 값:

```text
low, medium, high, xhigh, max
```

우선순위:

- Claude model: task `model` > `CODEX_AI_BRIDGE_CLAUDE_MODEL` > unset.
- Claude effort: task `effort` > `CODEX_AI_BRIDGE_CLAUDE_EFFORT` > unset.
- Provider max turns: task `maxTurns` > review preset 기본값(`4`) >
  `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` > policy 기본값(agentic은 `8`, 그 외는 `3`).

`maxTurns`는 bridge 호출 횟수가 아니라 provider 내부 continuation 한도입니다.
Claude는 `--max-turns`로 적용합니다. 현재 Gemini CLI에는 같은 의미의 flag가
없으므로 `gemini_task`는 cross-provider 요청 호환성을 위해 이 필드를 받지만
Gemini argv에는 별도 flag를 추가하지 않습니다. one-shot review gate는 보통 bridge
tool 호출을 1회로 제한한다는 뜻이지, 반드시 `--max-turns 1`이라는 뜻은 아닙니다.
넓은 Opus/max 리뷰는 `4` 정도가 실용적이고, `1`은 엄격한 단일 turn probe에만 쓰는
것을 권장합니다.

Gemini 작업은 `effort`를 받지 않습니다.

## Review Preset

`"preset": "review"`를 지정하면 긴 리뷰용 기본값을 사용합니다. Claude에서는 명시
값이 없을 때 `model: "opus"`, `effort: "max"`, `timeoutMs: 900000`,
`syncBudgetMs: 120000`, `maxTurns: 4`를 적용합니다. `cross_review`에서는
`maxTurns`가 Claude leg에 적용되고 Gemini leg에서도 schema 호환성을 위해
허용됩니다.

긴 리뷰에서 provider hard kill deadline을 없애고 싶다면 `"timeoutMs": 0`을
명시하거나 `CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS=0`을 설정하고 `preset` 필드는
생략하세요. `syncBudgetMs`는 `120000`처럼 양수로 둬야 MCP tool이 `jobId`를
반환하고 `ai_bridge_job`으로 polling할 수 있습니다.

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `CODEX_AI_BRIDGE_ROOT` | relative `cwd`를 제한할 저장소 루트입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_COMMAND` | Claude CLI command override입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_MODEL` | 기본 Claude 모델입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_EFFORT` | 기본 Claude effort입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` | 기본 Claude CLI 내부 turn 한도입니다. bridge 호출 횟수가 아닙니다. 넓은 one-call 리뷰 gate는 `4`, 엄격한 단일 turn probe는 `1`을 권장합니다. |
| `CODEX_AI_BRIDGE_DEFAULT_TIMEOUT_MS` | provider hard timeout입니다. 기본값은 `900000` ms입니다. `0`이면 hard timeout을 비활성화합니다. |
| `CODEX_AI_BRIDGE_SYNC_BUDGET_MS` | background job id를 반환하기 전 foreground 대기 시간입니다. 기본값은 `120000` ms입니다. `0`이면 provider가 종료될 때까지 기다립니다. |
| `CODEX_AI_BRIDGE_JOB_CHECK_MS` | 실행 중인 job liveness 상태를 갱신하는 주기입니다. 기본값은 `300000` ms입니다. |
| `CODEX_AI_BRIDGE_JOB_TTL_MS` | 완료된 in-memory job을 보관하는 시간입니다. 기본값은 1시간입니다. |
| `CODEX_AI_BRIDGE_GEMINI_COMMAND` | Gemini CLI command override입니다. |
| `CODEX_AI_BRIDGE_GEMINI_SANDBOX` | `1`이면 Gemini sandbox 옵션을 전달합니다. |
| `CODEX_AI_BRIDGE_ALLOW_AGENTIC` | `1`이면 `agentic` 정책을 허용합니다. |
| `CODEX_AI_BRIDGE_PROVIDER_LOCK` | 기본값은 활성화입니다. `0`이면 provider lock을 비활성화합니다. |
| `CODEX_AI_BRIDGE_LOCK_SCOPE` | 기본값은 `workspace`입니다. 이전 provider-wide lock 동작이 필요하면 `global`로 설정합니다. |
| `CODEX_AI_BRIDGE_LOCK_DIR` | cross-process provider lock 디렉터리를 override합니다. |
| `CODEX_AI_BRIDGE_LOCK_WAIT_MS` | provider lock을 기다릴 최대 시간입니다. hard timeout이 없으면 기본값은 24시간입니다. |
| `CODEX_AI_BRIDGE_LOCK_STALE_MS` | provider lock을 stale로 볼 기준 시간입니다. |

Provider lock은 같은 workspace의 여러 Codex 세션이 같은 외부 provider CLI를 동시에
실행하지 않게 합니다. 서로 다른 workspace는 기본적으로 다른 lock key를 사용하므로,
두 프로젝트가 Claude나 Gemini를 동시에 호출해도 한 세션이 다른 프로젝트 작업을
기다리느라 MCP tool budget을 소모하지 않습니다. 활성 lock은 heartbeat로 갱신하고,
죽은 owner process의 lock은 정리하며, Windows에서 timeout된 provider 호출은
process tree를 종료해 bridge lock 해제 뒤 Claude/Gemini 자식 process가 남지 않게
합니다.

오래 걸리는 provider 호출은 provider를 죽이는 timeout이 아니라 foreground sync
budget으로 제어합니다. `timeoutMs`는 일반 응답 대기 시간이 아니라 provider를
강제로 종료하는 hard kill deadline입니다. `syncBudgetMs`가 `0`이면 provider가
종료될 때까지 기다리고, client가 progress token을 제공하는 경우 job check
interval마다 MCP progress notification을 보냅니다. 양수 `syncBudgetMs` 안에
작업이 끝나지 않으면 tool은 `jobId`를 반환하고 provider는 background에서 계속
실행됩니다. 결과는 `ai_bridge_job`으로 조회합니다. 실행 중인 job은
`lastCheckedAt`, `elapsedMs`, check interval과 hard timeout까지 남은 시간을 함께
보여줍니다. `timeoutMs > 0`이고 `syncBudgetMs >= timeoutMs`이면 bridge가
`syncBudgetMs`를 자동으로 낮추고 warning을 추가해, 반환된 `jobId`를 hard timeout
전에 조회할 시간이 남게 합니다.

`timeoutMs: 240000`, `syncBudgetMs: 240000`처럼 같은 양수 값을 직접 전달하지
마세요. foreground budget이 끝나는 순간 hard kill deadline도 같이 오기 때문입니다.
긴 Claude Opus/max 리뷰는 `timeoutMs: 900000, syncBudgetMs: 120000` 또는
`timeoutMs: 0, syncBudgetMs: 120000`을 권장합니다. `"background": true`를 주면
즉시 `jobId`를 반환합니다.

provider command가 실패하면 실패 출력에 provider를 실행한 작업 디렉터리와 실제
`argv`가 포함됩니다. 따라서 `--max-turns` 같은 설정이 어떤 값으로 실행됐는지
오류 보고서에서 바로 확인할 수 있습니다. 또한 현재 Gemini CLI처럼 대응되는 argv
flag가 없는 provider도 실패 로그의 실제 argv로 확인할 수 있습니다.

## 예시

```json
{
  "preset": "review",
  "maxTurns": 4,
  "role": "reviewer",
  "policy": "advisory",
  "prompt": "Review the pending diff for correctness risks. Findings first."
}
```

이 호출이 background job id를 반환하면 다음처럼 조회합니다.

```json
{
  "jobId": "claude-..."
}
```

## 검증

```powershell
npm run check
```

검증은 공개 전이나 수정 후 권장하는 smoke check입니다. 일반적인 로컬 실행에
필수는 아닙니다.

런타임에서는 다음 MCP tool을 호출합니다.

```text
ai_bridge_health
```

## 보안 메모

- 프롬프트에 secrets를 넣지 마세요.
- bridge는 provider 출력에서 일반적인 token 패턴을 redact합니다.
- provider가 직접 수정하게 할 목적이 아니라면 `agentic`은 꺼두세요.

## 라이선스

MIT. 저장소 루트의 `LICENSE`를 참고하세요.
