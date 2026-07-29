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
  claimOrphanCallbacks,
  brokerStatus,
  completeBrokerUpdate,
  consumeBrokerUpdates,
  createBrokerSubscription,
  monitorConsumer,
  pollBrokerUpdates,
  releaseBrokerUpdate,
  retireBrokerSubscription,
  _test: brokerTest
} = require("../src/broker.js");

const sameCwdSessionA = monitorConsumer(tempDir, "session-a");
const sameCwdSessionB = monitorConsumer(tempDir, "session-b");
assert.notEqual(sameCwdSessionA.id, sameCwdSessionB.id);

const consumerA = {
  id: "aaaaaaaaaaaaaaaa",
  shortId: "aaaaaaaa",
  label: "ProjectA",
  cwd: path.join(tempDir, "a"),
  sessionId: "test-a"
};
const consumerB = {
  id: "bbbbbbbbbbbbbbbb",
  shortId: "bbbbbbbb",
  label: "ProjectB",
  cwd: path.join(tempDir, "b"),
  sessionId: "test-b"
};
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
  await createBrokerSubscription("choice:scoped-to-b", {
    startAtEnd: true,
    reset: true,
    routeConsumerId: consumerB.id,
    chatIds: ["10"],
    expiresInMs: 5000
  });
  batches.push([messageUpdate(7, "10", "choice fallback")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  const intercepted = await consumeBrokerUpdates("monitor:a", { mode: "monitor", consumerId: consumerA.id });
  assert.equal(intercepted.length, 1);
  assert.equal(intercepted[0].message.text, "choice fallback");
  assert.equal((await consumeBrokerUpdates("choice:scoped-to-b")).length, 0);

  // Button callbacks carry their chat inside callback_query.message, so they
  // have to be routed and swept just like plain messages.
  assert.equal(brokerTest.updateChatId(callbackUpdate(8, "10", "ctbc:abcd1234:0")), "10");
  assert.equal(brokerTest.callbackSubscriberId("ctbc:abcd1234:0"), "choice:abcd1234");
  assert.equal(brokerTest.callbackSubscriberId("ctba:a1b2c3:approve"), "permission:a1b2c3");
  assert.equal(brokerTest.callbackSubscriberId("not-a-callback"), "");

  await createBrokerSubscription("choice:abcd1234", {
    startAtEnd: true,
    reset: true,
    routeConsumerId: consumerA.id,
    chatIds: ["10"],
    expiresInMs: 60000
  });
  batches.push([callbackUpdate(8, "10", "ctbc:abcd1234:0")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerA, allowedChatIds: ["10"] });

  const routed = readBrokerRecord(8);
  assert.ok(routed.routeConsumerId, "callback records must be routed to a consumer");

  // A live telegram_ask owns its own callbacks; the sweep must not steal them.
  assert.equal((await claimOrphanCallbacks(routed.routeConsumerId)).length, 0);

  await retireBrokerSubscription("choice:abcd1234", { retainForMs: 60000 });
  const orphans = await claimOrphanCallbacks(routed.routeConsumerId);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].update.update_id, 8);
  assert.ok(orphans[0].receivedAt, "claimed callbacks carry their arrival time");
  assert.equal((await claimOrphanCallbacks(routed.routeConsumerId)).length, 0);
  assert.equal(await releaseBrokerUpdate(8, orphans[0].claimId), true);
  const reclaimed = await claimOrphanCallbacks(routed.routeConsumerId);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].update.update_id, 8);
  assert.equal(await completeBrokerUpdate(8, reclaimed[0].claimId), true);
  assert.equal((await claimOrphanCallbacks(routed.routeConsumerId)).length, 0);

  // Retired choice subscriptions keep the original project route long enough
  // for a delayed callback, even when another project owns normal chat input.
  batches.push([callbackUpdate(9, "10", "ctbc:abcd1234:0")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  assert.equal(readBrokerRecord(9).routeConsumerId, consumerA.id);
  assert.equal((await claimOrphanCallbacks(consumerB.id)).length, 0);
  const delayed = await claimOrphanCallbacks(consumerA.id);
  assert.equal(delayed.length, 1);
  assert.equal(delayed[0].update.update_id, 9);
  assert.equal(await completeBrokerUpdate(9, delayed[0].claimId), true);

  // Unknown callback namespaces belong to other/future handlers.
  batches.push([callbackUpdate(10, "10", "other:button")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  assert.equal((await claimOrphanCallbacks(consumerB.id)).length, 0);
  assert.equal((await claimOrphanCallbacks(consumerA.id)).length, 0);

  // A live session must never take another session's choice, but it may clear
  // the keyboard after the original consumer has gone stale.
  backdateBrokerConsumer(consumerA.id, 5 * 60 * 1000);
  batches.push([callbackUpdate(11, "10", "ctbc:abcd1234:0")]);
  await pollBrokerUpdates(api, 0, { consumer: consumerB, allowedChatIds: ["10"] });
  assert.equal(readBrokerRecord(11).routeConsumerId, consumerA.id);
  const cleanup = await claimOrphanCallbacks(consumerB.id);
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].update.update_id, 11);
  assert.equal(cleanup[0].deliverToSession, false);
  assert.equal(await completeBrokerUpdate(11, cleanup[0].claimId), true);

  // A process-scoped consumer disappears immediately when its PID is gone.
  // Pending normal messages are then reassigned to the newly polling session.
  seedDeadRoutedMessage();
  const replacement = {
    id: "cccccccccccccccc",
    shortId: "cccccccc",
    label: "Replacement",
    cwd: path.join(tempDir, "replacement"),
    sessionId: "replacement"
  };
  batches.push([]);
  await pollBrokerUpdates(api, 0, { consumer: replacement, allowedChatIds: ["20"] });
  assert.equal(readBrokerRecord(12).routeConsumerId, replacement.id);
  assert.equal(brokerTest.consumerIsLiveAt({
    lastSeenAt: new Date().toISOString(),
    processId: 2147483647
  }, Date.now()), false);

  // Pruning is itself a state change. It must be persisted even when the
  // caller's update is otherwise a no-op.
  await createBrokerSubscription("prune-probe", { startAtEnd: true, reset: true });
  seedExpiredBrokerRecord();
  await consumeBrokerUpdates("prune-probe");
  assert.equal(readBrokerRecord(13), undefined, "expired records are removed from the persisted broker state");

  fs.writeFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "{invalid-json");
  await assert.rejects(() => brokerStatus(consumerA.id), /Invalid Telegram broker state/);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function readBrokerRecord(updateId) {
  const state = JSON.parse(fs.readFileSync(process.env.CODEX_TELEGRAM_BROKER_STATE_FILE, "utf8"));
  return state.records.find((record) => Number(record.updateId) === updateId);
}

function backdateBrokerConsumer(consumerId, ageMs) {
  const file = process.env.CODEX_TELEGRAM_BROKER_STATE_FILE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.consumers[consumerId].lastSeenAt = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function seedDeadRoutedMessage() {
  const file = process.env.CODEX_TELEGRAM_BROKER_STATE_FILE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.consumers.dead = {
    id: "dead",
    label: "Stopped",
    cwd: path.join(tempDir, "stopped"),
    sessionId: "",
    processId: 2147483647,
    allowedChatIds: ["20"],
    lastSeenAt: new Date().toISOString()
  };
  state.chatRoutes["20"] = "dead";
  state.subscribers["choice:dead"] = {
    cursor: 0,
    routeConsumerId: "dead",
    chatIds: ["20"],
    interceptMessages: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  state.records.push({
    sequence: state.nextSequence,
    updateId: 12,
    receivedAt: new Date().toISOString(),
    routeConsumerId: "dead",
    control: false,
    update: messageUpdate(12, "20", "after restart")
  });
  state.nextSequence += 1;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function seedExpiredBrokerRecord() {
  const file = process.env.CODEX_TELEGRAM_BROKER_STATE_FILE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.records.push({
    sequence: state.nextSequence,
    updateId: 13,
    receivedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    routeConsumerId: "",
    control: false,
    update: messageUpdate(13, "10", "expired")
  });
  state.nextSequence += 1;
  fs.writeFileSync(file, JSON.stringify(state));
}

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
