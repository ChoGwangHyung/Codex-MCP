# Codex MCP

Codex MCP는 Codex 운영 워크플로에 쓰는 작은 MCP 서버 모음입니다.
각 서버는 독립 패키지로 유지해서 프로젝트별로 필요한 도구만 켤 수 있게
구성했습니다.

기본 영어 문서: [README.md](README.md)

## 포함 패키지

| 패키지 | 설명 |
| --- | --- |
| `@chogwanghyung/codex-ai-bridge-mcp` | Claude Code와 Gemini CLI를 호출해 제한된 범위의 기획, 리뷰, QA, 아키텍처, 보안, 구현 자문을 받습니다. |
| `@chogwanghyung/codex-telegram-bridge-mcp` | allowlist된 Telegram 채팅으로 메시지와 파일을 송수신하고, workflow 승인, Codex native permission request용 user-level hook 자동 설치, Telegram 메시지의 Codex 세션 릴레이를 지원합니다. |
| `@chogwanghyung/codex-done-notifier` | 선택한 Codex 세션이 끝났을 때 로컬 효과음과 화면 알림을 띄우는 Codex `Stop` hook입니다. |

## 설치

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp
npm install -g @chogwanghyung/codex-telegram-bridge-mcp
npm install -g @chogwanghyung/codex-done-notifier
```

세 패키지를 한 번에 설치하려면 다음처럼 실행합니다.

```powershell
npm install -g @chogwanghyung/codex-ai-bridge-mcp @chogwanghyung/codex-telegram-bridge-mcp @chogwanghyung/codex-done-notifier
```

패키지는 계속 독립적으로 versioning하고 설정합니다. 프로젝트별로 필요한 tool
또는 hook만 켜서 사용할 수 있습니다.

## 구조

```text
Codex-MCP/
  codex-ai-bridge-mcp/
  codex-telegram-bridge-mcp/
  codex-done-notifier/
```

## 검증

```powershell
npm run check
```

검증은 공개 전이나 수정 후 권장하는 smoke check입니다. 일반적인 로컬 실행에
필수는 아닙니다.

## 보안

토큰, chat ID, allowlist, runtime inbox 파일은 커밋하지 않습니다.
자세한 내용은 [SECURITY.md](SECURITY.md)를 참고하세요.

## 라이선스

MIT. [LICENSE](LICENSE)를 참고하세요.
