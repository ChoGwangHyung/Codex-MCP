# Codex Done Notifier

Codex Done Notifier는 Codex turn이 끝나는 `Stop` hook에서 로컬 효과음과
화면 알림을 띄우는 작은 도구입니다.

기본 영어 문서: [README.md](README.md)

MCP 서버가 아닙니다. 모델에게 보이는 tool을 추가하지 않으므로 토큰 비용이
늘어나지 않습니다. Codex lifecycle hook이 로컬에서 실행합니다.

## 설치

```powershell
npm install -g @chogwanghyung/codex-done-notifier
cd <project-dir>
codex-done-notifier configure
```

기본 `configure`는 현재 프로젝트의 `.codex/config.toml`만 수정하고, 관리되는
`Stop` hook command 안에 notifier 설정을 저장합니다.

여러 프로젝트에서 하나의 user-level hook을 공유하고 싶을 때만 global로
설치하세요.

```powershell
codex-done-notifier configure --global
```

## 이 저장소에서 설치

```powershell
git clone https://github.com/ChoGwangHyung/Codex-MCP.git
cd Codex-MCP
node .\codex-done-notifier\src\cli.js configure
```

저장소 checkout에서 실행할 때는 아래 예시의 `codex-done-notifier`를
`node <repo>\codex-done-notifier\src\cli.js`로 바꾸면 됩니다.

hook을 설치하거나 바꾼 뒤 이미 실행 중인 Codex 세션은 한 번 `exit` 후
`resume`해서 config를 다시 읽게 하는 것이 안전합니다.

Codex가 `/hooks`에서 hook review를 한 번 요구할 수 있습니다. Windows에서
같은 프로젝트를 `D:\Project`와 `d:\project`처럼 다른 대소문자 경로로
resume하면 같은 hook도 다시 review 대상으로 보일 수 있습니다. 이 경우
프로젝트 폴더에서 다음 명령을 실행하세요.

```powershell
codex-done-notifier trust
```

현재 hook hash를 일반 경로와 lowercase 경로 형태 모두로 `~/.codex/config.toml`에
기록합니다.

## 특정 프로젝트만 켜기

`configure`는 현재 프로젝트 알림을 자동으로 켭니다. `disable` 후 다시 켜거나,
다른 프로젝트를 켤 때 `enable`을 사용합니다.

```powershell
cd <project-dir>
codex-done-notifier enable
```

이 파일이 업데이트됩니다.

```text
.codex/config.toml
```

프로젝트별 sound preset 지정:

```powershell
codex-done-notifier enable --sound exclamation
```

지원 preset은 `ding`, `asterisk`, `beep`, `exclamation`, `hand`, `question`,
`none`입니다. 기본 sound는 `exclamation`입니다.

프로젝트별 sound file 지정:

```powershell
codex-done-notifier enable --sound-file .codex\done.wav
```

Windows custom sound는 `System.Media.SoundPlayer`를 사용하므로 `.wav`가 가장
안전합니다. macOS custom sound는 `afplay`로 재생합니다.

화면 알림은 유지하고 소리만 끄기:

```powershell
codex-done-notifier enable --no-sound
```

소리는 유지하고 화면 알림만 끄기:

```powershell
codex-done-notifier enable --no-notification
```

둘 다 꺼지면 프로젝트는 비활성 상태처럼 동작합니다. 이후 plain `enable`을
실행하면 둘 다 다시 켜집니다. 하나만 끈 상태에서 전체 `disable`을 실행했다면,
이후 plain `enable`은 그 하나만 꺼진 선호 상태를 복원합니다.

끄기:

```powershell
codex-done-notifier disable
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
| `configure --no-enable` | hook을 비활성 상태로 설치합니다. |
| `unconfigure` | 현재 프로젝트의 관리 hook block을 제거합니다. |
| `unconfigure --global` | user-level 관리 hook block을 제거합니다. |
| `enable` | 현재 프로젝트에서 알림을 켭니다. |
| `enable --session <id>` | 특정 Codex session id에서만 알림을 켭니다. |
| `enable --sound <preset>` | 현재 프로젝트의 sound preset을 설정합니다. |
| `enable --sound-file <path>` | 현재 프로젝트의 sound file을 설정합니다. |
| `enable --no-sound` 또는 `enable --notification-only` | 소리만 끕니다. |
| `enable --no-notification` 또는 `enable --sound-only` | 화면 알림만 끕니다. |
| `disable` | 현재 프로젝트에서 알림을 끕니다. |
| `status` | hook과 현재 프로젝트 상태를 확인합니다. |
| `trust` | 현재 hook trust hash를 Windows 경로 대소문자 variant까지 기록합니다. |
| `test` | 테스트 알림을 보냅니다. |
| `hook-snippet` | hook TOML snippet을 출력합니다. |

## Hook 동작

hook은 stdin으로 받은 Codex hook JSON을 읽고 다음 조건을 확인합니다.

- `CODEX_DONE_NOTIFIER_ENABLED=1`
- `CODEX_DONE_NOTIFIER_SESSION_IDS`
- `.codex/config.toml`에 저장된 관리 hook 옵션

조건에 맞지 않으면 조용히 종료합니다.

## 문제 확인

현재 프로젝트 상태를 먼저 확인하세요.

```powershell
codex-done-notifier status
codex-done-notifier test
```

`status`에서 `hook_installed: yes`, `hook_reviewed: yes`,
`enabled_here: yes`가 보여야 합니다. `hook_trust_status`와 현재 hook hash도
함께 출력됩니다. Codex 세션이 이미 열린 뒤 hook을 설치했거나 trust
처리했다면, 해당 세션은 한 번 `exit` 후 `resume`해서 hook config를 다시
읽게 해야 합니다.

resume 뒤 같은 Stop hook을 계속 review하라고 나오면 Windows 경로 대소문자
차이 때문에 Codex hook trust key가 달라진 경우가 많습니다. 프로젝트
폴더에서 `codex-done-notifier trust`를 실행한 뒤 세션을 한 번 `exit` 후
`resume`하세요.

`test`가 `sent`를 출력하는데도 아무 알림이 없다면 hook 실행 자체는 가능한
상태이고, 대개 Windows Focus Assist, PowerShell/터미널 알림 차단, silent
system sound scheme 같은 데스크톱 알림 환경 문제입니다. Windows에서는
BurntToast module이 있으면 이를 사용하고, 없으면 tray balloon으로
fallback합니다. sound preset은 `[Console]::Beep`를 사용하고 system sound로
fallback하며, custom `.wav`는 `enable --sound-file`로 지정할 수 있습니다.
기본 Windows `exclamation` preset은 먼저
`C:\Windows\Media\Windows Exclamation.wav`를 재생합니다.

## 요구사항

- Node.js 20 이상
- Codex hooks 활성화
- Windows: Windows Runtime toast notification을 먼저 사용하고, BurntToast가
  있으면 사용하며, 마지막으로 tray balloon notification으로 fallback합니다.
  sound는 built-in `.wav`, `[Console]::Beep`, 또는 custom `.wav` file을 사용합니다.
- macOS: `osascript` notification과 system sound 또는 `afplay` file을 사용합니다.
- Linux: 가능한 경우 `notify-send` notification을 사용합니다. sound playback은
  기본 활성화하지 않습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
