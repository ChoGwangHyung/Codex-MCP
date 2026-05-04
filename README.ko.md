# Codex MCP

Codex MCP는 Codex 운영 워크플로에 쓰는 작은 MCP 서버 모음입니다.
각 서버는 독립 패키지로 유지해서 프로젝트별로 필요한 도구만 켤 수 있게
구성했습니다.

기본 영어 문서: [README.md](README.md)

## 포함 MCP 서버

| MCP | 설명 |
| --- | --- |
| `codex-ai-bridge-mcp` | Claude Code와 Gemini CLI를 호출해 제한된 범위의 기획, 리뷰, QA, 아키텍처, 보안, 구현 자문을 받습니다. |
| `codex-telegram-bridge-mcp` | allowlist된 Telegram 채팅으로 메시지와 파일을 송수신하고, workflow 승인, Codex native permission request용 user-level hook 자동 설치, Telegram 메시지의 Codex 세션 릴레이를 지원합니다. |

## 구조

```text
Codex-MCP/
  codex-ai-bridge-mcp/
  codex-telegram-bridge-mcp/
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
