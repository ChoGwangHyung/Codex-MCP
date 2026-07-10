"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-broker-"));
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.CODEX_TELEGRAM_BROKER_STATE_FILE = path.join(tempDir, "broker.json");
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "local-state.json");

const {
  claimBrokerUpdate,
  brokerStatus,
  consumeBrokerUpdates,
  createBrokerSubscription,
  pollBrokerUpdates
} = require("../src/broker.js");

const consumerA = { id: "aaaaaaaaaaaaaaaa", shortId: "aaaaaaaa", label: "ProjectA", cwd: path.join(tempDir, "a") };
const consumerB = { id: "bbbbbbbbbbbbbbbb", shortId: "bbbbbbbb", label: "ProjectB", cwd: path.join(tempDir, "b") };
let batches = [];
const api = async (method, payload) => {
  assert.equal(method, "getUpdates");
  const batch = batches.shift() || [];
  if (batch.length) assert.ok(payload.offset <= batch[0].update_id);
  return batch;
};

(async () => {
  await createBrokerSubscription("monitor:a", { startAtEnd: false });
  await createBrokerSubscription("monitor:b", { startAtEnd: false });
  batches.push([messageUpdate(1, "10", "first")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });
  assert.equal((await consumeBrokerUpdates("monitor:a", { mode: "monitor", consumerId: consumerA.id, startAtEnd: false })).length, 1);
  assert.equal((await consumeBrokerUpdates("monitor:b", { mode: "monitor", consumerId: consumerB.id, startAtEnd: false })).length, 0);

  batches.push([]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });

  batches.push([messageUpdate(2, "10", "/sessions")]);
  const sessions = await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });
  assert.equal(sessions.controlActions.length, 1);
  assert.match(sessions.controlActions[0].text, /ProjectA/);
  assert.match(sessions.controlActions[0].text, /ProjectB/);

  batches.push([messageUpdate(3, "10", "/use bbbbbbbb")]);
  const selected = await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });
  assert.match(selected.controlActions[0].text, /ProjectB/);

  batches.push([messageUpdate(4, "10", "second")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });
  assert.equal((await consumeBrokerUpdates("monitor:a", { mode: "monitor", consumerId: consumerA.id })).length, 0);
  assert.equal((await consumeBrokerUpdates("monitor:b", { mode: "monitor", consumerId: consumerB.id })).length, 1);

  await createBrokerSubscription("permission:one", { startAtEnd: true, reset: true });
  await createBrokerSubscription("choice:one", { startAtEnd: true, reset: true });
  batches.push([callbackUpdate(5, "10", "callback-data")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });
  assert.equal((await consumeBrokerUpdates("permission:one")).length, 1);
  assert.equal((await consumeBrokerUpdates("choice:one")).length, 1);

  batches.push([messageUpdate(6, "10", "claimed")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  assert.equal(await claimBrokerUpdate(6, "choice:one"), true);
  assert.equal((await consumeBrokerUpdates("monitor:b", { mode: "monitor", consumerId: consumerB.id })).length, 0);

  await createBrokerSubscription("choice:routed-to-a", {
    startAtEnd: true,
    reset: true,
    routeConsumerId: consumerA.id,
    chatIds: ["10"],
    interceptMessages: true,
    expiresInMs: 5000
  });
  batches.push([messageUpdate(7, "10", "choice fallback")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  const intercepted = await consumeBrokerUpdates("monitor:a", { mode: "monitor", consumerId: consumerA.id });
  assert.equal(intercepted.length, 1);
  assert.equal(intercepted[0].message.text, "choice fallback");

  fs.writeFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "{invalid-json");
  await assert.rejects(() => brokerStatus(consumerA.id), /Invalid Telegram broker state/);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function messageUpdate(updateId, chatId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId },
      from: { id: 1, first_name: "User" },
      text
    }
  };
}

function callbackUpdate(updateId, chatId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data,
      from: { id: 1 },
      message: { message_id: updateId, chat: { id: chatId } }
    }
  };
}
