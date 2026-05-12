# Codex Done Notifier

Codex Done Notifier는 Codex turn이 끝나는 `Stop` hook에서 로컬 효과음과
화면 알림을 띄우는 작은 도구입니다.

기본 영어 문서: [README.md](README.md)

MCP 서버가 아닙니다. 모델에게 보이는 tool을 추가하지 않으므로 토큰 비용이
늘어나지 않습니다. Codex lifecycle hook이 로컬에서 실행합니다.

## 이 저장소에서 설치

```powershell
git clone https://github.com/ChoGwangHyung/Codex-MCP.git
cd Codex-MCP
node .\codex-done-notifier\src\cli.js configure
```

기본 `configure`는 현재 프로젝트의 `.codex/config.toml`만 수정하고, 동시에
`.codex/notify-on-stop` marker를 만들어 그 프로젝트의 알림을 켭니다.

여러 프로젝트에서 하나의 user-level hook을 공유하고 싶을 때만 global로
설치하세요.

```powershell
node .\codex-done-notifier\src\cli.js configure --global
```

나중에 전역 설치하면 같은 명령을 이렇게 사용할 수 있습니다.

```powershell
codex-done-notifier configure
```

hook을 설치하거나 바꾼 뒤 이미 실행 중인 Codex 세션은 한 번 `exit` 후
`resume`해서 config를 다시 읽게 하는 것이 안전합니다.

## 특정 프로젝트만 켜기

`configure`는 현재 프로젝트 알림을 자동으로 켭니다. `disable` 후 다시 켜거나,
다른 프로젝트를 켤 때 `enable`을 사용합니다.

```powershell
cd D:\Projects\SomeProject
node D:\Projects\MCP\Codex-MCP\codex-done-notifier\src\cli.js enable
```

이 파일이 생성됩니다.

```text
.codex/notify-on-stop
```

끄기:

```powershell
node D:\Projects\MCP\Codex-MCP\codex-done-notifier\src\cli.js disable
```

## 특정 세션만 켜기

터미널에서 시작하거나 resume하는 Codex 세션 하나에만 켜려면 실행 전에
환경 변수를 지정합니다.

```powershell
$env:CODEX_DONE_NOTIFIER_ENABLED = "1"
codex resume
```

Codex session id를 알고 있다면 다음 방식도 사용할 수 있습니다.

```powershell
codex-done-notifier enable --session <session-id>
```

또는:

```powershell
$env:CODEX_DONE_NOTIFIER_SESSION_IDS = "<session-id>"
codex resume
```

## 명령

| 명령 | 용도 |
| --- | --- |
| `configure` | 현재 프로젝트의 Codex `Stop` hook을 설치하고 알림을 켭니다. |
| `configure --global` | user-level Codex `Stop` hook을 설치하고 현재 프로젝트 알림을 켭니다. |
| `configure --no-enable` | project marker를 만들지 않고 hook만 설치합니다. |
| `unconfigure` | 현재 프로젝트의 관리 hook block을 제거합니다. |
| `unconfigure --global` | user-level 관리 hook block을 제거합니다. |
| `enable` | 현재 프로젝트에서 알림을 켭니다. |
| `enable --session <id>` | 특정 Codex session id에서만 알림을 켭니다. |
| `disable` | 현재 프로젝트에서 알림을 끕니다. |
| `status` | hook과 현재 프로젝트 상태를 확인합니다. |
| `test` | 테스트 알림을 보냅니다. |
| `hook-snippet` | hook TOML snippet을 출력합니다. |

## Hook 동작

hook은 stdin으로 받은 Codex hook JSON을 읽고 다음 조건을 확인합니다.

- `CODEX_DONE_NOTIFIER_ENABLED=1`
- `CODEX_DONE_NOTIFIER_SESSION_IDS`
- 현재 directory 또는 상위 directory의 `.codex/notify-on-stop` marker

조건에 맞지 않으면 조용히 종료합니다.

## 요구사항

- Node.js 20 이상
- Codex hooks 활성화
- Windows 알림을 1차 지원합니다. macOS는 `osascript`, Linux는 가능한 경우
  `notify-send`를 사용합니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
