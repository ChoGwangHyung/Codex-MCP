"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-stop-hook-"));
process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

const { handleStopHook, selectPendingReply, telegramTextChunks } = require("../src/stop-hook.js");
const { readTelegramState, writeTelegramState } = require("../src/state.js");

(async () => {
  const deliveredAt = new Date().toISOString();
  writeTelegramState({
    inbox: [
      {
        id: "update-1",
        chatId: "12345",
        text: "작업 끝나면 알려줘",
        relayStatus: "delivered",
        relayThreadId: "session-1",
        relayTurnId: "turn-1",
        relayDeliveredAt: deliveredAt
      }
    ],
    relay: {
      pendingReplies: [
        {
          id: "update-1",
          inboxMessageId: "update-1",
          chatId: "12345",
          threadId: "session-1",
          turnId: "turn-1",
          cwd: "D:/Projects/TalkLog",
          deliveredAt,
          status: "pending"
        }
      ]
    }
  });

  const sent = [];
  const result = await handleStopHook({
    hook_event_name: "Stop",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "D:/Projects/TalkLog",
    last_assistant_message: "완료했습니다.\n검증도 통과했습니다."
  }, {
    sendText: async ({ chatId, text }) => {
      sent.push({ chatId, text });
    }
  });

  assert.equal(result.sent, true);
  assert.deepEqual(sent, [
    {
      chatId: "12345",
      text: "완료했습니다.\n검증도 통과했습니다."
    }
  ]);

  let state = readTelegramState();
  assert.equal(state.relay.pendingReplies[0].status, "sent");
  assert.equal(state.inbox[0].relayReplyStatus, "sent");
  assert.ok(state.inbox[0].relayReplySentAt);

  const duplicate = await handleStopHook({
    hook_event_name: "Stop",
    session_id: "session-1",
    turn_id: "turn-1",
    cwd: "D:/Projects/TalkLog",
    last_assistant_message: "중복"
  }, {
    sendText: async ({ chatId, text }) => {
      sent.push({ chatId, text });
    }
  });
  assert.equal(duplicate.sent, false);
  assert.equal(sent.length, 1);

  assert.equal(selectPendingReply([
    { id: "old", chatId: "12345", threadId: "session-2", cwd: "d:/projects/talklog", deliveredAt: "2026-01-01T00:00:00.000Z", status: "pending" },
    { id: "new", chatId: "12345", threadId: "session-2", cwd: "d:/projects/talklog", deliveredAt: "2026-01-02T00:00:00.000Z", status: "pending" }
  ], {
    hook_event_name: "Stop",
    session_id: "session-2",
    cwd: "D:/Projects/TalkLog"
  }).id, "new");
  assert.equal(selectPendingReply([
    { id: "cwd-only", chatId: "12345", cwd: "d:/projects/talklog", deliveredAt: "2026-01-02T00:00:00.000Z", status: "pending" }
  ], {
    hook_event_name: "Stop",
    session_id: "cli-session",
    cwd: "D:/Projects/TalkLog"
  }), null);

  assert.deepEqual(telegramTextChunks("x".repeat(4000)).map((chunk) => chunk.length), [3900, 100]);

  state = readTelegramState();
  assert.equal(state.relay.pendingReplies.length, 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
