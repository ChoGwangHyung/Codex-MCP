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
const {
  choiceSubscriberId,
  parseChoiceCallbackData
} = require("./choices.js");
const {
  approvalSubscriberId,
  parseApprovalCallbackData
} = require("./approval.js");

const BROKER_VERSION = 1;
const CONSUMER_STALE_MS = 2 * 60 * 1000;
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const SUBSCRIBER_STALE_MS = 60 * 60 * 1000;
const ORPHAN_CLAIM_STALE_MS = 2 * 60 * 1000;
const MAX_RECORDS = 2000;
// Liveness only has to stay well inside CONSUMER_STALE_MS. Rewriting the
// heartbeat on every single poll made an idle wait loop dirty the state file
// continuously, which defeats the unchanged-state write skip below.
const HEARTBEAT_RESOLUTION_MS = 20000;

function heartbeat(previous, resolutionMs = HEARTBEAT_RESOLUTION_MS) {
  const seenAt = Date.parse(previous || "");
  if (Number.isFinite(seenAt) && Date.now() - seenAt < resolutionMs) return previous;
  return new Date().toISOString();
}

const consumerCache = new Map();

// Two realpath syscalls plus a SHA-256 per call, and the broker asks for this
// several times per poll cycle. The inputs are all in the cache key, so a
// changed cwd, session, or state path still produces a fresh identity.
function monitorConsumer(cwd = process.cwd(), sessionId = "") {
  const configuredSession = String(
    sessionId ||
    process.env.CODEX_TELEGRAM_CODEX_THREAD_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    ""
  ).trim();
  const statePath = telegramStatePath();
  const cacheKey = `${cwd}\0${configuredSession}\0${statePath}`;
  const cached = consumerCache.get(cacheKey);
  if (cached) return cached;

  const canonicalCwd = canonicalPath(cwd);
  const processIdentity = configuredSession || `process:${process.pid}`;
  const identity = `${canonicalPath(statePath)}\n${canonicalCwd}\n${processIdentity}`;
  const id = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const consumer = {
    id,
    shortId: id.slice(0, 8),
    label: path.basename(canonicalCwd) || "Codex",
    cwd: canonicalCwd,
    sessionId: configuredSession,
    processId: configuredSession ? 0 : process.pid
  };
  if (consumerCache.size > 32) consumerCache.clear();
  consumerCache.set(cacheKey, consumer);
  return consumer;
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
    subscriber.lastSeenAt = heartbeat(subscriber.lastSeenAt);
    state.subscribers[id] = subscriber;

    if (options.mode === "monitor") {
      const consumerId = String(options.consumerId || "");
      return available
        .filter((record) => !record.claimedBy && record.routeConsumerId === consumerId && record.update && record.update.message)
        .map((record) => record.update);
    }
    const routeConsumerId = String(subscriber.routeConsumerId || "");
    return available
      .filter((record) => !routeConsumerId || record.routeConsumerId === routeConsumerId)
      .map((record) => record.update);
  });
}

async function claimOrphanCallbacks(consumerId, options = {}) {
  const owner = String(consumerId || "");
  const claimPrefix = String(options.claimId || `orphan:${owner}`);
  const graceMs = Number(options.graceMs) > 0 ? Number(options.graceMs) : 0;
  const limit = Math.max(1, Number(options.limit) || MAX_RECORDS);
  const now = Date.now();

  return updateBrokerState((state) => {
    const consumer = state.consumers[owner];
    const allowedChatIds = consumer ? consumer.allowedChatIds : [];
    const claimed = [];

    for (const record of state.records) {
      if (claimed.length >= limit) break;
      if (record.claimedBy && !orphanClaimIsStale(record, now)) continue;
      const callback = record.update && record.update.callback_query;
      if (!callback) continue;
      if (!callbackSubscriberId(callback.data)) continue;
      const ownership = callbackClaimOwnership(state, record, owner, allowedChatIds, now);
      if (!ownership) continue;
      const receivedAt = Date.parse(record.receivedAt || "");
      if (Number.isFinite(receivedAt) && now - receivedAt < graceMs) continue;
      if (hasActiveCallbackOwner(state, callback.data, now)) continue;
      const claimId = `${claimPrefix}:${Number(record.updateId)}`;
      record.claimedBy = claimId;
      record.claimedAt = new Date().toISOString();
      claimed.push({
        update: record.update,
        receivedAt: record.receivedAt,
        claimId,
        deliverToSession: ownership.deliverToSession
      });
    }
    return claimed;
  });
}

function callbackClaimOwnership(state, record, consumerId, allowedChatIds, now) {
  if (record.routeConsumerId) {
    if (record.routeConsumerId === consumerId) return { deliverToSession: true };
    if (consumerIsLiveAt(state.consumers[record.routeConsumerId], now)) return null;
    const chatId = updateChatId(record.update);
    return Boolean(chatId) && allowedChatIds.includes(chatId)
      ? { deliverToSession: false }
      : null;
  }
  const chatId = updateChatId(record.update);
  return Boolean(chatId) && allowedChatIds.includes(chatId)
    ? { deliverToSession: true }
    : null;
}

function orphanClaimIsStale(record, now) {
  if (!String(record.claimedBy || "").startsWith("orphan:")) return false;
  const claimedAt = Date.parse(record.claimedAt || "");
  return !Number.isFinite(claimedAt) || now - claimedAt > ORPHAN_CLAIM_STALE_MS;
}

function hasActiveCallbackOwner(state, data, now) {
  const subscriberId = callbackSubscriberId(data);
  if (!subscriberId) return false;
  const subscriber = state.subscribers[subscriberId];
  if (!subscriber) return false;
  const expiresAt = Date.parse(subscriber.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function callbackSubscriberId(data) {
  const choice = parseChoiceCallbackData(data);
  if (choice) return choiceSubscriberId(choice.requestId);
  const approval = parseApprovalCallbackData(data);
  return approval ? approvalSubscriberId(approval.code) : "";
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

async function releaseBrokerUpdate(updateId, claimId) {
  const id = Number(updateId);
  const owner = String(claimId || "");
  if (!Number.isFinite(id) || !owner) return false;
  return updateBrokerState((state) => {
    const record = state.records.find((item) => Number(item.updateId) === id);
    if (!record || record.claimedBy !== owner) return false;
    delete record.claimedBy;
    delete record.claimedAt;
    return true;
  });
}

async function completeBrokerUpdate(updateId, claimId) {
  const id = Number(updateId);
  const owner = String(claimId || "");
  if (!Number.isFinite(id) || !owner) return false;
  return updateBrokerState((state) => {
    const record = state.records.find((item) => Number(item.updateId) === id);
    if (!record || record.claimedBy !== owner) return false;
    record.claimedBy = `handled:${owner}`;
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

async function retireBrokerSubscription(subscriberId, options = {}) {
  const id = String(subscriberId || "").trim();
  if (!id) return;
  const retainForMs = Math.max(0, Number(options.retainForMs) || 0);
  await updateBrokerState((state) => {
    const subscriber = state.subscribers[id];
    if (!subscriber) return;
    const now = new Date();
    subscriber.expiresAt = now.toISOString();
    subscriber.interceptMessages = false;
    subscriber.retiredAt = now.toISOString();
    subscriber.retainUntil = new Date(now.getTime() + retainForMs).toISOString();
    subscriber.lastSeenAt = now.toISOString();
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
    const chatId = updateChatId(update);
    const command = message && chatId && liveConsumersForChat(state, chatId).length > 0
      ? parseRoutingCommand(message.text)
      : null;
    let routeConsumerId = "";
    if (command) {
      controlActions.push(handleRoutingCommand(state, chatId, command));
    } else if (chatId) {
      routeConsumerId = callbackRouteConsumer(state, update, chatId) ||
        routeConsumer(state, chatId, pollingConsumerId);
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
      return subscriber.routeConsumerId &&
        consumerIsLiveAt(state.consumers[subscriber.routeConsumerId], now) &&
        (!Number.isFinite(expiresAt) || expiresAt > now);
    })
    .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0]?.routeConsumerId || "";
}

function routeUnassignedRecords(state, consumerId) {
  const consumer = state.consumers[consumerId];
  if (!consumer) return;
  for (const record of state.records) {
    const chatId = updateChatId(record.update);
    const routedConsumer = state.consumers[record.routeConsumerId];
    const isCallback = Boolean(record.update && record.update.callback_query);
    const handled = String(record.claimedBy || "").startsWith("handled:");
    if (
      record.control ||
      handled ||
      !chatId ||
      (record.routeConsumerId && (isCallback || consumerIsLive(routedConsumer)))
    ) continue;
    if (!consumer.allowedChatIds.includes(chatId)) continue;
    record.routeConsumerId = callbackRouteConsumer(state, record.update, chatId) ||
      routeConsumer(state, chatId, consumerId);
  }
}

function callbackRouteConsumer(state, update, chatId) {
  const callback = update && update.callback_query;
  const subscriberId = callbackSubscriberId(callback && callback.data);
  if (!subscriberId) return "";
  const subscriber = state.subscribers[subscriberId];
  if (!subscriber || !subscriber.routeConsumerId) return "";
  const chatIds = normalizeStringList(subscriber.chatIds);
  if (chatIds.length > 0 && !chatIds.includes(String(chatId))) return "";
  return String(subscriber.routeConsumerId);
}

function registerConsumer(state, consumer, allowedChatIds) {
  const existing = state.consumers[consumer.id];
  state.consumers[consumer.id] = {
    id: consumer.id,
    label: consumer.label,
    cwd: consumer.cwd,
    sessionId: String(consumer.sessionId || ""),
    processId: normalizeProcessId(consumer.processId),
    allowedChatIds,
    lastSeenAt: heartbeat(existing && existing.lastSeenAt)
  };
}

function liveConsumersForChat(state, chatId) {
  return Object.values(state.consumers)
    .filter((consumer) => consumerIsLive(consumer) && consumer.allowedChatIds.includes(String(chatId)))
    .sort((left, right) => Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt));
}

function consumerIsLive(consumer) {
  return consumerIsLiveAt(consumer, Date.now());
}

function consumerIsLiveAt(consumer, now) {
  const seenAt = Date.parse(consumer && consumer.lastSeenAt || "");
  if (!Number.isFinite(seenAt) || now - seenAt > CONSUMER_STALE_MS) return false;
  if (String(consumer && consumer.sessionId || "")) return true;
  const processId = normalizeProcessId(consumer && consumer.processId);
  return processId > 0 && processIsRunning(processId);
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function normalizeProcessId(value) {
  const processId = Number(value);
  return Number.isInteger(processId) && processId > 0 ? processId : 0;
}

function updateChatId(update) {
  const message = update && update.message;
  if (message && message.chat) return String(message.chat.id);
  const callback = update && update.callback_query;
  const callbackMessage = callback && callback.message;
  return callbackMessage && callbackMessage.chat ? String(callbackMessage.chat.id) : "";
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
      sessionId: String(consumer.sessionId || ""),
      processId: normalizeProcessId(consumer.processId),
      allowedChatIds: normalizeStringList(consumer.allowedChatIds),
      lastSeenAt: String(consumer.lastSeenAt || "")
    }]];
  }));
}

function pruneBrokerState(state) {
  const now = Date.now();
  for (const [id, subscriber] of Object.entries(state.subscribers)) {
    const retainUntil = Date.parse(subscriber && subscriber.retainUntil || "");
    if (Number.isFinite(retainUntil)) {
      if (retainUntil > now) continue;
      delete state.subscribers[id];
      continue;
    }
    const seen = Date.parse(subscriber && subscriber.lastSeenAt || "");
    if (Number.isFinite(seen) && now - seen > SUBSCRIBER_STALE_MS) delete state.subscribers[id];
  }
  for (const [id, consumer] of Object.entries(state.consumers)) {
    const seen = Date.parse(consumer && consumer.lastSeenAt || "");
    const processBound = !String(consumer && consumer.sessionId || "");
    if (
      (processBound && !consumerIsLiveAt(consumer, now)) ||
      (Number.isFinite(seen) && now - seen > RECORD_TTL_MS)
    ) {
      delete state.consumers[id];
    }
  }
  for (const [chatId, consumerId] of Object.entries(state.chatRoutes)) {
    if (!state.consumers[consumerId]) delete state.chatRoutes[chatId];
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

// Read-shaped callers (cursor polls that find nothing new) run through here
// too, and the state file holds up to MAX_RECORDS full Telegram updates.
// Comparing the serialized form is far cheaper than the temp-write plus rename
// it avoids, so an unchanged state is never written back.
async function updateBrokerState(update) {
  return withFileLock(brokerLockPath(), async () => {
    const state = readBrokerState();
    const before = JSON.stringify(normalizeBrokerState(state));
    pruneBrokerState(state);
    const result = await update(state);
    const after = JSON.stringify(normalizeBrokerState(state));
    if (after !== before || !brokerStateFileExists()) writeBrokerState(after);
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

function brokerStateFileExists() {
  try {
    return fs.statSync(brokerStatePath()).isFile();
  } catch {
    return false;
  }
}

function writeBrokerState(serialized) {
  const file = brokerStatePath();
  const payload = typeof serialized === "string"
    ? serialized
    : JSON.stringify(normalizeBrokerState(serialized));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Permission hardening is best effort on filesystems without POSIX modes.
    }
  }
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
  retireBrokerSubscription,
  claimBrokerUpdate,
  releaseBrokerUpdate,
  completeBrokerUpdate,
  claimOrphanCallbacks,
  brokerStatus,
  _test: {
    brokerStatePath,
    callbackSubscriberId,
    canonicalPath,
    consumerIsLiveAt,
    normalizeBrokerState,
    parseRoutingCommand,
    updateChatId
  }
};
