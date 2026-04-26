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

## 요구 사항

- Node.js 20 이상.
- `@BotFather`에서 발급받은 Telegram bot token.
- 해당 bot에 `/start` 또는 메시지를 이미 보낸 Telegram 채팅.
- 이 MCP 서버를 등록한 Codex 프로젝트.
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

relay prompt는 작업 완료 전에 같은 `chatId`로 `telegram_send`를 호출하라는
지시를 항상 포함합니다.

relay 상태 확인:

```text
telegram_relay_status
```

## Approval Helper

MCP 서버는 Codex native permission prompt를 대체할 수 없습니다. 이 bridge는
명시적으로 호출하는 workflow helper만 제공합니다.

```text
telegram_approval_request
```

이 MCP 서버를 연결하는 것만으로 Codex native permission prompt가 Telegram으로
자동 전달되지는 않습니다. agent나 workflow가 `telegram_approval_request`를
명시적으로 호출해야 합니다.

helper는 Telegram quick-reply 버튼으로 approve/deny 응답을 받습니다. 해당 도구를
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
