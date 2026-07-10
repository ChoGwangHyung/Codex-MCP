"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  telegramStatePath
} = require("./config.js");
const {
  telegramTokenHash,
  withFileLock,
  withTelegramUpdateLock
} = require("./state.js");

const BROKER_VERSION = 1;
const CONSUMER_STALE_MS = 2 * 60 * 1000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const SUBSCRIBER_STALE_MS = 60 * 60 * 1000;
const MAX_RECORDS = 2000;

function monitorConsumer(cwd = process.cwd()) {
  const canonicalCwd = canonicalPath(cwd);
  const identity = `${canonicalPath(telegramStatePath())}\n${canonicalCwd}`;
  const id = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return {
    id,
    shortId: id.slice(0, 8),
    label: path.basename(canonicalCwd) || "Codex",
    cwd: canonicalCwd
  };
}

async function pollBrokerUpdates(telegramApiFn, timeoutSeconds, options = {}) {
  const consumer = options.consumer || monitorConsumer(options.cwd);
  const allowedChats = normalizeStringList(options.allowedChatIds);
  await updateBrokerState((state) => {
    registerConsumer(state, consumer, allowedChats);
    if (Number(options.seedOffset) > state.updateOffset && state.records.length === 0) {
      state.updateOffset = Number(options.seedOffset);
    }
    routeUnassignedRecords(state, consumer.id);
  });

  return withTelegramUpdateLock(async () => {
    const offset = await inspectBrokerState((state) => Number(state.updateOffset || 0));
    const updates = await telegramApiFn("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      limit: 100,
      allowed_updates: ["message", "callback_query"]
    });
    return updateBrokerState((state) => {
      registerConsumer(state, consumer, allowedChats);
      return ingestUpdates(state, updates, consumer.id);
    });
  });
}

async function createBrokerSubscription(subscriberId, options = {}) {
  const id = String(subscriberId || "").trim();
  if (!id) throw new Error("broker subscriber id is required");
  await updateBrokerState((state) => {
    const existing = options.reset === true ? null : state.subscribers[id];
    state.subscribers[id] = {
      ...(existing || {}),
      cursor: existing
        ? Number(existing.cursor || 0)
        : (options.startAtEnd === false ? oldestSequence(state) - 1 : Number(state.nextSequence || 1) - 1),
      routeConsumerId: String(options.routeConsumerId || existing && existing.routeConsumerId || ""),
      chatIds: normalizeStringList(options.chatIds || existing && existing.chatIds),
      interceptMessages: options.interceptMessages === true || Boolean(existing && existing.interceptMessages),
      expiresAt: Number(options.expiresInMs) > 0
        ? new Date(Date.now() + Number(options.expiresInMs)).toISOString()
        : String(existing && existing.expiresAt || ""),
      createdAt: String(existing && existing.createdAt || new Date().toISOString()),
      lastSeenAt: new Date().toISOString()
    };
  });
  return id;
}

async function consumeBrokerUpdates(subscriberId, options = {}) {
  const id = String(subscriberId || "").trim();
  if (!id) throw new Error("broker subscriber id is required");
  return updateBrokerState((state) => {
    const subscriber = state.subscribers[id] || {
      cursor: options.startAtEnd === false ? oldestSequence(state) - 1 : Number(state.nextSequence || 1) - 1
    };
    const cursor = Number(subscriber.cursor || 0);
    const available = state.records.filter((record) => Number(record.sequence) > cursor);
    const latest = available.length ? Number(available[available.length - 1].sequence) : cursor;
    subscriber.cursor = latest;
    subscriber.lastSeenAt = new Date().toISOString();
    state.subscribers[id] = subscriber;

    if (options.mode === "monitor") {
      const consumerId = String(options.consumerId || "");
      return available
        .filter((record) => !record.claimedBy && record.routeConsumerId === consumerId && record.update && record.update.message)
        .map((record) => record.update);
    }
    return available.map((record) => record.update);
  });
}

async function claimBrokerUpdate(updateId, claimId) {
  const id = Number(updateId);
  if (!Number.isFinite(id)) return false;
  return updateBrokerState((state) => {
    const record = state.records.find((item) => Number(item.updateId) === id);
    if (!record) return false;
    if (record.claimedBy && record.claimedBy !== claimId) return false;
    record.claimedBy = String(claimId || "claimed");
    record.claimedAt = new Date().toISOString();
    return true;
  });
}

async function removeBrokerSubscription(subscriberId) {
  const id = String(subscriberId || "").trim();
  if (!id) return;
  await updateBrokerState((state) => {
    delete state.subscribers[id];
  });
}

async function brokerStatus(consumerId) {
  return inspectBrokerState((state) => ({
    updateOffset: state.updateOffset,
    records: state.records.length,
    consumers: Object.values(state.consumers).map((consumer) => ({
      id: consumer.id,
      shortId: consumer.id.slice(0, 8),
      label: consumer.label,
      active: consumerIsLive(consumer),
      current: consumer.id === consumerId
    })),
    routes: { ...state.chatRoutes }
  }));
}

function ingestUpdates(state, updates, pollingConsumerId) {
  const seen = new Set(state.records.map((record) => Number(record.updateId)));
  const controlActions = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const updateId = Number(update && update.update_id);
    if (!Number.isFinite(updateId)) continue;
    state.updateOffset = Math.max(Number(state.updateOffset || 0), updateId + 1);
    if (seen.has(updateId)) continue;
    seen.add(updateId);

    const message = update.message;
    const chatId = message && message.chat && String(message.chat.id);
    const command = chatId && liveConsumersForChat(state, chatId).length > 0
      ? parseRoutingCommand(message.text)
      : null;
    let routeConsumerId = "";
    if (command) {
      controlActions.push(handleRoutingCommand(state, chatId, command));
    } else if (chatId) {
      routeConsumerId = routeConsumer(state, chatId, pollingConsumerId);
    }
    state.records.push({
      sequence: Number(state.nextSequence || 1),
      updateId,
      receivedAt: new Date().toISOString(),
      routeConsumerId,
      control: Boolean(command),
      update
    });
    state.nextSequence = Number(state.nextSequence || 1) + 1;
  }
  pruneBrokerState(state);
  return {
    updates: Array.isArray(updates) ? updates : [],
    updateOffset: state.updateOffset,
    controlActions: controlActions.filter(Boolean)
  };
}

function handleRoutingCommand(state, chatId, command) {
  const candidates = liveConsumersForChat(state, chatId);
  if (command.name === "sessions") {
    return {
      chatId,
      text: candidates.length
        ? ["Available Codex sessions:", ...candidates.map((consumer) => {
            const active = state.chatRoutes[chatId] === consumer.id ? " *" : "";
            return `- ${consumer.label} (${consumer.id.slice(0, 8)})${active}`;
          }), "Use /use <id> to select one."].join("\n")
        : "No active Codex Telegram sessions."
    };
  }

  const key = String(command.value || "").toLowerCase();
  const matches = candidates.filter((consumer) => {
    return consumer.id.toLowerCase().startsWith(key) || String(consumer.label || "").toLowerCase() === key;
  });
  if (matches.length === 1) {
    state.chatRoutes[chatId] = matches[0].id;
    return { chatId, text: `Active Codex session: ${matches[0].label} (${matches[0].id.slice(0, 8)})` };
  }
  return {
    chatId,
    text: matches.length > 1
      ? "Session id is ambiguous. Use /sessions and a longer id."
      : "Session not found. Use /sessions to list active sessions."
  };
}

function routeConsumer(state, chatId, pollingConsumerId) {
  const intercepted = interceptedRouteConsumer(state, chatId);
  if (intercepted) return intercepted;
  const candidates = liveConsumersForChat(state, chatId);
  const activeId = state.chatRoutes[chatId];
  if (activeId && candidates.some((consumer) => consumer.id === activeId)) return activeId;
  const polling = candidates.find((consumer) => consumer.id === pollingConsumerId);
  const selected = polling || candidates[0];
  if (!selected) return "";
  state.chatRoutes[chatId] = selected.id;
  return selected.id;
}

function interceptedRouteConsumer(state, chatId) {
  const now = Date.now();
  return Object.values(state.subscribers)
    .filter((subscriber) => {
      if (!subscriber || subscriber.interceptMessages !== true) return false;
      if (!Array.isArray(subscriber.chatIds) || !subscriber.chatIds.includes(String(chatId))) return false;
      const expiresAt = Date.parse(subscriber.expiresAt || "");
      return subscriber.routeConsumerId && (!Number.isFinite(expiresAt) || expiresAt > now);
    })
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0]?.routeConsumerId || "";
}

function routeUnassignedRecords(state, consumerId) {
  const consumer = state.consumers[consumerId];
  if (!consumer) return;
  for (const record of state.records) {
    const message = record.update && record.update.message;
    const chatId = message && message.chat && String(message.chat.id);
    if (record.control || record.routeConsumerId || !chatId) continue;
    if (!consumer.allowedChatIds.includes(chatId)) continue;
    record.routeConsumerId = routeConsumer(state, chatId, consumerId);
  }
}

function registerConsumer(state, consumer, allowedChatIds) {
  state.consumers[consumer.id] = {
    id: consumer.id,
    label: consumer.label,
    cwd: consumer.cwd,
    allowedChatIds,
    lastSeenAt: new Date().toISOString()
  };
}

function liveConsumersForChat(state, chatId) {
  return Object.values(state.consumers)
    .filter((consumer) => consumerIsLive(consumer) && consumer.allowedChatIds.includes(String(chatId)))
    .sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt));
}

function consumerIsLive(consumer) {
  const seenAt = Date.parse(consumer && consumer.lastSeenAt || "");
  return Number.isFinite(seenAt) && Date.now() - seenAt <= CONSUMER_STALE_MS;
}

function parseRoutingCommand(text) {
  const value = String(text || "").trim();
  if (/^\/sessions(?:@[A-Za-z0-9_]+)?\s*$/i.test(value)) return { name: "sessions" };
  const match = /^\/use(?:@[A-Za-z0-9_]+)?\s+([^\s]+)\s*$/i.exec(value);
  return match ? { name: "use", value: match[1] } : null;
}

function normalizeBrokerState(value) {
  const state = value && typeof value === "object" ? value : {};
  const records = Array.isArray(state.records)
    ? state.records.filter((record) => record && Number.isFinite(Number(record.sequence)))
    : [];
  const nextSequence = Math.max(
    Number.isFinite(Number(state.nextSequence)) ? Number(state.nextSequence) : 1,
    records.reduce((maximum, record) => Math.max(maximum, Number(record.sequence) + 1), 1)
  );
  return {
    version: BROKER_VERSION,
    updateOffset: Number.isFinite(Number(state.updateOffset)) ? Number(state.updateOffset) : 0,
    nextSequence,
    records,
    consumers: normalizeConsumers(state.consumers),
    subscribers: state.subscribers && typeof state.subscribers === "object" ? state.subscribers : {},
    chatRoutes: state.chatRoutes && typeof state.chatRoutes === "object" ? state.chatRoutes : {}
  };
}

function normalizeConsumers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, consumer]) => {
    if (!consumer || typeof consumer !== "object") return [];
    return [[id, {
      ...consumer,
      id: String(consumer.id || id),
      label: String(consumer.label || "Codex"),
      cwd: String(consumer.cwd || ""),
      allowedChatIds: normalizeStringList(consumer.allowedChatIds),
      lastSeenAt: String(consumer.lastSeenAt || "")
    }]];
  }));
}

function pruneBrokerState(state) {
  const now = Date.now();
  for (const [id, subscriber] of Object.entries(state.subscribers)) {
    const seen = Date.parse(subscriber && subscriber.lastSeenAt || "");
    if (Number.isFinite(seen) && now - seen > SUBSCRIBER_STALE_MS) delete state.subscribers[id];
  }
  for (const [id, consumer] of Object.entries(state.consumers)) {
    const seen = Date.parse(consumer && consumer.lastSeenAt || "");
    if (Number.isFinite(seen) && now - seen > RECORD_TTL_MS) delete state.consumers[id];
  }
  state.records = state.records
    .filter((record) => {
      const receivedAt = Date.parse(record.receivedAt || "");
      return !Number.isFinite(receivedAt) || now - receivedAt <= RECORD_TTL_MS;
    })
    .slice(-MAX_RECORDS);
}

function oldestSequence(state) {
  return state.records.length ? Number(state.records[0].sequence) : Number(state.nextSequence || 1);
}

async function inspectBrokerState(read) {
  return withFileLock(brokerLockPath(), async () => read(readBrokerState()));
}

async function updateBrokerState(update) {
  return withFileLock(brokerLockPath(), async () => {
    const state = readBrokerState();
    pruneBrokerState(state);
    const result = await update(state);
    writeBrokerState(state);
    return result;
  });
}

function readBrokerState() {
  try {
    return normalizeBrokerState(JSON.parse(fs.readFileSync(brokerStatePath(), "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") return normalizeBrokerState({});
    throw new Error(`Invalid Telegram broker state at ${brokerStatePath()}: ${error.message}`);
  }
}

function writeBrokerState(state) {
  const file = brokerStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalizeBrokerState(state), null, 2));
  fs.renameSync(temp, file);
}

function brokerStatePath() {
  if (process.env.CODEX_TELEGRAM_BROKER_STATE_FILE) return process.env.CODEX_TELEGRAM_BROKER_STATE_FILE;
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "CodexTelegramBridge", "broker", telegramTokenHash());
  return path.join(dir, "state.json");
}

function brokerLockPath() {
  return `${brokerStatePath()}.lock`;
}

function canonicalPath(value) {
  let resolved = path.normalize(path.resolve(String(value || process.cwd())));
  try { resolved = fs.realpathSync.native(resolved); } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeStringList(values) {
  return [...new Set(Array.from(values || []).map(String).filter(Boolean))];
}

module.exports = {
  monitorConsumer,
  pollBrokerUpdates,
  createBrokerSubscription,
  consumeBrokerUpdates,
  removeBrokerSubscription,
  claimBrokerUpdate,
  brokerStatus,
  _test: {
    brokerStatePath,
    canonicalPath,
    normalizeBrokerState,
    parseRoutingCommand
  }
};
