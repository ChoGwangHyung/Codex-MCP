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
| `ai_bridge_health` | provider CLI 사용 가능 여부를 확인합니다. |

주요 사용 예:

- 큰 구현 전 Plan Gate 리뷰.
- 변경 후 최종 diff 리뷰.
- 읽기 전용 아키텍처·보안 리뷰.
- Claude/Gemini 병렬 second opinion.

Telegram 도구는 의도적으로 포함하지 않았습니다. 알림과 승인은
`codex-telegram-bridge-mcp`를 사용하세요.

## 요구 사항

- Node.js 20 이상.
- `claude_task`를 쓰려면 Claude Code CLI.
- `gemini_task`를 쓰려면 Gemini CLI.
- 이 MCP 서버가 등록된 Codex 프로젝트.

## Codex 설정

프로젝트 `.codex/config.toml`에 추가합니다.

```toml
[mcp_servers.codex-ai-bridge]
command = "node"
args = ["<Codex-MCP>/codex-ai-bridge-mcp/src/index.js"]

[mcp_servers.codex-ai-bridge.env]
CODEX_AI_BRIDGE_ROOT = "<ProjectRoot>"
CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS = "1"
# 선택 provider 기본값:
# CODEX_AI_BRIDGE_CLAUDE_MODEL = "<claude-model>"
# CODEX_AI_BRIDGE_CLAUDE_EFFORT = "high"
```

Windows에서는 forward slash 또는 escape된 backslash를 사용하세요.

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

## Claude 모델과 effort

`claude_task`는 다음 인자를 지원합니다.

```json
{
  "model": "<claude-model>",
  "effort": "high"
}
```

Effort 값:

```text
low, medium, high, xhigh, max
```

우선순위:

- Claude model: task `model` > `CODEX_AI_BRIDGE_CLAUDE_MODEL` > unset.
- Claude effort: task `effort` > `CODEX_AI_BRIDGE_CLAUDE_EFFORT` > unset.

Gemini 작업은 `effort`를 받지 않습니다.

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `CODEX_AI_BRIDGE_ROOT` | relative `cwd`를 제한할 저장소 루트입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_COMMAND` | Claude CLI command override입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_MODEL` | 기본 Claude 모델입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_EFFORT` | 기본 Claude effort입니다. |
| `CODEX_AI_BRIDGE_CLAUDE_MAX_TURNS` | Claude max turns입니다. one-shot gate는 `1`을 권장합니다. |
| `CODEX_AI_BRIDGE_GEMINI_COMMAND` | Gemini CLI command override입니다. |
| `CODEX_AI_BRIDGE_GEMINI_SANDBOX` | `1`이면 Gemini sandbox 옵션을 전달합니다. |
| `CODEX_AI_BRIDGE_ALLOW_AGENTIC` | `1`이면 `agentic` 정책을 허용합니다. |
| `CODEX_AI_BRIDGE_PROVIDER_LOCK` | 기본값은 활성화입니다. `0`이면 여러 세션의 같은 provider 동시 호출을 허용합니다. |
| `CODEX_AI_BRIDGE_LOCK_DIR` | cross-process provider lock 디렉터리를 override합니다. |
| `CODEX_AI_BRIDGE_LOCK_WAIT_MS` | provider lock을 기다릴 최대 시간입니다. 기본값은 task timeout입니다. |
| `CODEX_AI_BRIDGE_LOCK_STALE_MS` | provider lock을 stale로 볼 기준 시간입니다. |

Provider lock은 여러 Codex 세션이 같은 외부 provider CLI를 동시에 실행하지 않게
합니다. Claude/Gemini CLI의 세션, quota, 로컬 상태 충돌을 줄이면서도 Claude와
Gemini 서로 다른 provider는 병렬 실행됩니다.

## 예시

```json
{
  "role": "reviewer",
  "policy": "advisory",
  "prompt": "Review the pending diff for correctness risks. Findings first."
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
