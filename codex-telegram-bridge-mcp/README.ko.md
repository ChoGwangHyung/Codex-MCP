# Codex Telegram Bridge MCP

Codex Telegram Bridge MCP는 allowlist에 등록된 Telegram 채팅과 Codex 세션을
연결하는 재사용 가능한 MCP 서버입니다.

기본 영어 문서: [README.md](README.md)

이 bridge는 Codex 운영자 협업용 도구입니다. 범용 Telegram 봇 프레임워크가
아닙니다.

## 제공 기능

| Tool | 목적 |
| --- | --- |
| `telegram_send` | allowlist에 등록된 Telegram 채팅으로 메시지를 보냅니다. |
| `telegram_wait_reply` | allowlist 채팅의 다음 응답 1개를 기다립니다. |
| `telegram_ask` | 메시지를 보내고 응답 1개를 기다립니다. |
| `telegram_inbox_read` | 수신 monitor가 캡처한 메시지를 읽거나 consume합니다. |
| `telegram_monitor_status` | monitor offset, inbox 크기, 오류 상태를 확인합니다. |
| `telegram_relay_status` | Telegram-to-Codex relay 설정과 대기 메시지를 확인합니다. |
| `telegram_approval_request` | 명시적 workflow approval을 Telegram으로 요청합니다. |
| `telegram_bridge_health` | token, allowlist, runtime 상태를 확인합니다. |

패키지에는 Codex hook command도 포함되어 있습니다.

| Command | 목적 |
| --- | --- |
| `codex-telegram-permission-hook` | Codex native `PermissionRequest` 승인을 Telegram으로 처리합니다. |

## 요구 사항

- Node.js 20 이상.
- `@BotFather`에서 발급받은 Telegram bot token.
- 해당 bot에 `/start` 또는 메시지를 이미 보낸 Telegram 채팅.
- 이 MCP 서버를 등록한 Codex 프로젝트.
- native permission approval을 사용하려면 Codex hooks 활성화.
- 기본 Telegram 도구는 Node.js가 동작하는 환경에서 사용할 수 있습니다. Console
  relay mode는 bundled Windows PowerShell helper를 사용하므로, 다른 플랫폼에서는
  `app-server` mode를 쓰거나 relay를 끄는 구성을 사용하세요.

Telegram bot은 먼저 사용자에게 DM을 보낼 수 없습니다. 따라서 pairing은 사용자가
bot을 열거나 deep-link Start 버튼을 누르는 방식으로 시작합니다.

## 저장소 구조

```text
codex-telegram-bridge-mcp/
├─ src/                         # MCP server, Telegram monitor, relay modules
├─ scripts/                     # pairing helper와 Windows console relay helper
├─ README.md
└─ README.ko.md
```

## Codex 설정

대상 프로젝트의 `.codex/config.toml`에 서버를 추가합니다.

```toml
[mcp_servers.codex-telegram-bridge]
command = "node"
args = ["<Codex-MCP>/codex-telegram-bridge-mcp/src/index.js"]

[mcp_servers.codex-telegram-bridge.env]
CODEX_TELEGRAM_BRIDGE_ENV_FILE = "<ProjectRoot>/.codex/config.toml.env"
CODEX_TELEGRAM_BRIDGE_ACCESS_FILE = "<ProjectRoot>/.codex/config.toml.access.json"
CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR = "<ProjectRoot>/.codex/telegram-runtime"
```

실제 secret은 `.codex/config.toml`에 넣지 않습니다. project-specific runtime
설정은 `.codex/config.toml.env`에 두고 gitignore합니다.

```dotenv
CODEX_TELEGRAM_BRIDGE_ENABLED=1
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_CHAT_IDS=<chat-id>
CODEX_TELEGRAM_CODEX_RELAY_MODE=console
CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING=1
CODEX_TELEGRAM_CODEX_SUBMIT_DELAY_MS=150
# 선택 native Codex permission approval:
# CODEX_TELEGRAM_APPROVAL_CHAT_IDS=<chat-id>
# CODEX_TELEGRAM_PERMISSION_TIMEOUT_MS=300000
# CODEX_TELEGRAM_PERMISSION_TIMEOUT_BEHAVIOR=ask
# CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED=1
# CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL=1
```

커밋에는 안전한 `.codex/config.toml.env.example`만 포함합니다.

npm global 설치로 사용할 경우 MCP command에 package binary를 지정할 수 있습니다.

```toml
[mcp_servers.codex-telegram-bridge]
command = "codex-telegram-bridge-mcp"
```

## Pairing 흐름

Clipboard 설정:

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js token-clipboard
```

명령은 BotFather token을 로컬 clipboard에서 읽고 token을 출력하지 않은 채
저장합니다. 이후 짧은 pairing code와 Telegram deep link를 생성합니다.

출력된 `pair_link`를 열고 Telegram에서 Start를 누른 뒤 pairing합니다.

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js pair <code>
```

스크립트는 최근 Telegram update에서 `/start <code>` 또는 raw code를 찾고,
`message.chat.id`를 추출해 allowlist에 추가한 뒤 pending pairing code를
삭제합니다.

pending code가 정확히 1개면 인자 없이 `pair`를 실행할 수 있습니다.

## 설정 명령

configure script를 직접 사용합니다.

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

token 또는 allowlist가 바뀐 뒤에는 Codex를 restart/resume해서 MCP 서버가 저장된
환경과 access 파일을 다시 읽게 해야 합니다.

## 자동 수신 Monitor

설정이 완료되면 서버는 Telegram `getUpdates` monitor를 시작합니다. allowlist에
등록된 텍스트 메시지를 capped runtime inbox에 저장하고, 공유 offset을
전진시키며, allowlist 밖의 채팅은 무시합니다.

캡처된 메시지 읽기:

```text
telegram_inbox_read
```

읽고 consume하기:

```json
{
  "chatId": "<chat-id>",
  "consume": true
}
```

monitor 상태 확인:

```text
telegram_monitor_status
```

## Choice 질문

`telegram_ask`는 inline keyboard 선택지를 보내고, 버튼 클릭 또는 텍스트 fallback
응답을 기다릴 수 있습니다. Claude fallback 결정 같은 흐름에 사용할 수 있습니다.

```json
{
  "message": "Claude review를 사용할 수 없습니다. 다음 동작을 선택하세요.",
  "choices": [
    { "label": "진행", "value": "proceed" },
    { "label": "대기", "value": "wait" },
    { "label": "중단", "value": "stop" }
  ],
  "timeoutMs": 300000
}
```

allowlist chat이 정확히 1개면 `chatId`를 생략할 수 있습니다. 기본 UX는 버튼
클릭입니다. callback 전달이 실패하거나 버튼을 사용할 수 없는 client에서는 label
또는 value를 텍스트로 입력해도 fallback으로 처리됩니다.

선택 결과:

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

Timeout 결과:

```json
{
  "status": "timeout",
  "timeout": true,
  "chatId": "12345",
  "messageId": 99
}
```

## Telegram-To-Codex Relay

bridge 설정이 완료되면 allowlist Telegram 메시지는 기본적으로 활성 Codex
세션에 relay됩니다. Windows에서는 console mode가 기본입니다.

```dotenv
CODEX_TELEGRAM_CODEX_RELAY_MODE=console
```

지원 relay mode:

| Mode | 사용처 |
| --- | --- |
| `console` | Windows Codex TUI 세션. 대상 console에 text와 Enter를 주입합니다. |
| `app-server` | Codex app-server stream. 해당 stream에 client가 연결된 경우에만 유용합니다. |

Console relay 세부 사항:

- 가능하면 bridge process의 ancestor 중 Codex console을 자동 감지합니다.
- `CODEX_TELEGRAM_CODEX_CONSOLE_PID`로 대상 console을 명시할 수 있습니다.
- `CODEX_TELEGRAM_CODEX_SUBMIT_DELAY_MS`는 text 입력 후 Enter 전송 지연입니다.
- `CODEX_TELEGRAM_CODEX_RELAY_IGNORE_EXISTING=1`은 과거 inbox 메시지와 pairing 메시지를 건너뜁니다.
- Codex app-server 상태를 읽을 수 있으면 idle gate로 사용하고, 대상 thread가 busy이면 재시도합니다.

relay prompt는 Telegram `chatId` 표시와 사용자 메시지 본문만 포함합니다.

relay 상태 확인:

```text
telegram_relay_status
```

## Codex Native Permission Approval

Codex가 native approval prompt를 표시하기 직전에 bundled hook command를 호출하게
설정할 수 있습니다. hook은 요청 내용을 Telegram으로 보내고, Telegram 응답을
Codex의 `allow` 또는 `deny` 결정으로 반환합니다.

MCP 서버가 시작되고 Telegram 설정이 완료되어 있으면 user-level Codex
`PermissionRequest` hook을 `$CODEX_HOME/config.toml` 또는
`%USERPROFILE%/.codex/config.toml`에 자동 설치합니다. 프로젝트별
`.codex/config.toml`은 수정하지 않습니다. 그래서 기존 Codex 프로젝트에서도
프로젝트별 설정 없이 hook을 사용할 수 있습니다.

현재 실행 중인 Codex process가 hook 설치 전에 config를 이미 읽었다면, 한 번
restart/resume이 필요할 수 있습니다. 이후에는 MCP 연결과 user-level hook만으로
native permission request가 Telegram으로 전달됩니다.

자동 hook 설치를 끄려면 `CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL=0`을
설정합니다. 같은 hook snippet을 확인하거나 수동 설치하려면 다음 명령을 사용합니다.

```powershell
node <Codex-MCP>/codex-telegram-bridge-mcp/scripts/telegram-configure.js hook-snippet
```

이 명령은 TOML snippet을 출력합니다.

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

npm global 설치로 사용할 경우 package binary를 사용할 수 있습니다.

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

동작:

- approval prompt는 shell escalation, managed-network approval, `apply_patch`,
  MCP tool approval 같은 Codex `PermissionRequest` 이벤트에서 실행됩니다.
- bundled `PostToolUse` hook은 요청이 CLI prompt로 fallback된 뒤 CLI에서 승인되어
  tool이 실행되면 Telegram 메시지를 승인 처리 상태로 업데이트합니다. CLI 거부는
  tool이 실행되지 않기 때문에 현재 Codex hook 이벤트만으로는 확정 감지할 수
  없습니다.
- Telegram에는 `승인` / `항상 승인` / `거부` inline 버튼이 표시됩니다. 내부 요청
  code는 callback payload 안에만 있고 메시지 본문에는 표시하지 않습니다. 첫 응답이
  접수되면 버튼은 제거됩니다.
- `항상 승인`은 같은 session, cwd, tool name, 정확히 같은 tool input signature에
  대한 bridge-side 승인을 저장합니다. Codex의 전역 permission 설정은 변경하지
  않습니다. 저장된 항상 승인을 쓰지 않으려면 Telegram runtime state 파일을
  삭제하거나 `CODEX_TELEGRAM_ALWAYS_APPROVAL_ENABLED=0`을 설정합니다.
- 텍스트 fallback은 같은 allowlist chat에서 `approve`, `승인`, `deny`, `거부`
  같은 응답을 계속 허용합니다. `always approve`, `항상 승인`도 같은 bridge-side
  항상 승인 동작으로 처리합니다.
- `CODEX_TELEGRAM_APPROVAL_CHAT_IDS`가 있으면 해당 allowlist chat으로만 요청을
  보냅니다. 없으면 모든 allowlist chat으로 보냅니다.
- Telegram timeout 시 기본값은 `ask`이며, 일반 Codex approval prompt로
  fallback합니다. `CODEX_TELEGRAM_PERMISSION_TIMEOUT_BEHAVIOR=deny`를 설정하면
  timeout 시 deny로 fail closed합니다.
- hook config를 제거하지 않고 끄려면 `CODEX_TELEGRAM_PERMISSION_APPROVAL_ENABLED=0`을
  설정합니다.

hook은 MCP 서버와 같은 token, allowlist, runtime 파일을 사용합니다. Telegram
env/access file path는 Codex hook 환경이나 project-local `.codex/config.toml.env`에
설정하세요.

## Workflow Approval Helper

Codex native permission과 별개로 agent workflow 안에서 명시적인 승인 단계가
필요하면 다음 MCP tool을 호출합니다.

```text
telegram_approval_request
```

helper는 Telegram inline 버튼으로 승인/항상 승인/거부 응답을 받습니다. 해당 도구를
의도적으로 호출하는 workflow에서만 사용하세요.

## 상태 파일

Project-local 상태:

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

Access JSON 저장 값:

- `allowFrom`: allowlist에 등록된 Telegram chat ID.
- `pending`: 임시 pairing code.
- `dmPolicy`: `allowlist` 또는 `disabled`.

## 보안 메모

- 이 bridge는 local-first 구조이며 기본적으로 public inbound service를 열지
  않습니다. 다만 Telegram token과 allowlist된 채팅은 계속 보호해야 합니다.
- 기본 access policy는 `allowlist`입니다.
- pairing code는 기본 10분 후 만료됩니다.
- pairing은 최근 Telegram update에 일치하는 code가 있어야만 성공합니다.
- Telegram 메시지는 자기 chat ID 승인이나 bridge policy 변경을 직접 수행할 수 없습니다.
- MCP 도구는 allowlist에 등록된 채팅에만 send/wait할 수 있습니다.
- 일반적인 token 형식은 사용자-facing error에서 sanitize됩니다.
- `token-clipboard`를 권장합니다. token을 chat에 붙여 넣으면 conversation history에 남을 수 있습니다.
- live bot token, chat ID, access file, runtime inbox file은 절대 커밋하지 않습니다.

## 검증

```powershell
cd <Codex-MCP>/codex-telegram-bridge-mcp
npm run check
node scripts/telegram-configure.js status
```

검증은 공개 전이나 수정 후 권장하는 smoke check입니다. 일반적인 로컬 실행에
필수는 아닙니다.

Codex에서 다음 도구를 확인합니다.

```text
telegram_bridge_health
telegram_monitor_status
telegram_relay_status
telegram_send
telegram_wait_reply
telegram_ask
```

## 라이선스

MIT. 저장소 루트의 `LICENSE`를 참고하세요.
