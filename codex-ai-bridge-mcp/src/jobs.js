"use strict";

const { sanitize } = require("./util.js");
const { DEFAULT_JOB_CHECK_MS } = require("./constants.js");

const jobs = new Map();
const DEFAULT_JOB_TTL_MS = 60 * 60 * 1000;

function startJob(provider, args, run) {
  cleanupJobs();
  const job = {
    jobId: `${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    provider,
    status: "running",
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    warnings: Array.isArray(args.warnings) ? args.warnings : [],
    startedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    checkIntervalMs: jobCheckMs(),
    pid: null,
    providerStartedAt: null,
    providerElapsedMs: null,
    completedAt: null,
    result: null,
    error: null,
    failureKind: null,
    monitor: null,
    promise: null
  };
  startJobMonitor(job);
  job.promise = Promise.resolve()
    .then(() => run(job))
    .then((result) => {
      const outcome = normalizeOutcome(result, provider);
      job.status = outcome.ok ? "completed" : outcome.status;
      job.result = outcome.text;
      job.failureKind = outcome.failureKind || null;
      if (Number.isInteger(outcome.pid)) job.pid = outcome.pid;
      if (Number.isInteger(outcome.elapsedMs)) job.providerElapsedMs = outcome.elapsedMs;
      return job;
    })
    .catch((error) => {
      job.status = "failed";
      job.error = sanitize(error && error.message ? error.message : String(error));
      job.result = `${provider} failed: ${job.error}`;
      job.failureKind = "exception";
      return job;
    })
    .finally(() => {
      job.completedAt = new Date().toISOString();
      markJobChecked(job);
      stopJobMonitor(job);
    });
  jobs.set(job.jobId, job);
  return job;
}

async function waitForJob(job, waitMs, options = {}) {
  if (!job || job.status !== "running") return true;
  if (!Number.isInteger(waitMs) || waitMs < 0) return false;
  const deadline = waitMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + waitMs;
  while (job.status === "running") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const sleepMs = Math.min(job.checkIntervalMs, remainingMs);
    const completed = await Promise.race([
      job.promise.then(() => true),
      delay(sleepMs).then(() => false)
    ]);
    if (completed) return true;
    markJobChecked(job);
    if (typeof options.onProgress === "function") options.onProgress(job);
  }
  return true;
}

function getJob(jobId) {
  cleanupJobs();
  return jobs.get(String(jobId || ""));
}

function formatJobPending(job, reason) {
  const elapsedMs = jobElapsedMs(job);
  return [
    ...formatWarnings(job),
    `${job.provider} job is running.`,
    `jobId: ${job.jobId}`,
    "status: running",
    reason ? `note: ${reason}` : null,
    `startedAt: ${job.startedAt}`,
    `elapsedMs: ${elapsedMs}`,
    `providerStatus: ${job.providerStartedAt ? "running" : "waiting_for_lock"}`,
    job.providerStartedAt ? `providerStartedAt: ${job.providerStartedAt}` : null,
    job.providerStartedAt ? `queueElapsedMs: ${Date.parse(job.providerStartedAt) - Date.parse(job.startedAt)}` : null,
    `lastCheckedAt: ${job.lastCheckedAt}`,
    `heartbeatIntervalMs: ${job.checkIntervalMs}`,
    job.timeoutMs > 0 ? `hardTimeoutMs: ${job.timeoutMs}` : "hardTimeoutMs: disabled",
    job.timeoutMs > 0 ? `hardTimeoutRemainingMs: ${hardTimeoutRemainingMs(job)}` : null,
    job.timeoutMs > 0 && !job.providerStartedAt ? "hardTimeoutNote: countdown starts when the provider process launches" : null,
    job.pid ? `pid: ${job.pid}` : null,
    "Poll with ai_bridge_job using this jobId."
  ].filter(Boolean).join("\n");
}

function formatJobStatus(jobId) {
  const job = getJob(jobId);
  if (!job) return `job not found: ${sanitize(String(jobId || ""))}`;
  if (job.status === "running") return formatJobPending(job);
  return [
    ...formatWarnings(job),
    `${job.provider} job finished.`,
    `jobId: ${job.jobId}`,
    `status: ${job.status}`,
    `startedAt: ${job.startedAt}`,
    job.providerStartedAt ? `providerStartedAt: ${job.providerStartedAt}` : null,
    job.completedAt ? `completedAt: ${job.completedAt}` : null,
    `elapsedMs: ${jobElapsedMs(job)}`,
    Number.isInteger(job.providerElapsedMs) ? `providerElapsedMs: ${job.providerElapsedMs}` : null,
    job.pid ? `pid: ${job.pid}` : null,
    job.failureKind ? `failureKind: ${job.failureKind}` : null,
    job.result || (job.status === "completed" ? `${job.provider} result:\n(no output)` : `${job.provider} failed`)
  ].filter(Boolean).join("\n");
}

function formatWarnings(job) {
  return (job && Array.isArray(job.warnings) ? job.warnings : []).map((warning) => `warning: ${warning}`);
}

function jobElapsedMs(job) {
  const end = job && job.completedAt ? Date.parse(job.completedAt) : Date.now();
  return end - Date.parse(job.startedAt);
}

function hardTimeoutRemainingMs(job) {
  if (!job || !Number.isInteger(job.timeoutMs) || job.timeoutMs <= 0) return null;
  if (!job.providerStartedAt) return job.timeoutMs;
  return Math.max(0, job.timeoutMs - (Date.now() - Date.parse(job.providerStartedAt)));
}

function cleanupJobs() {
  const now = Date.now();
  const ttlMs = jobTtlMs();
  for (const [jobId, job] of jobs) {
    if (job.status === "running" || !job.completedAt) continue;
    if (now - Date.parse(job.completedAt) > ttlMs) jobs.delete(jobId);
  }
}

function jobTtlMs() {
  const configured = Number(process.env.CODEX_AI_BRIDGE_JOB_TTL_MS);
  if (Number.isInteger(configured) && configured >= 60000) return configured;
  return DEFAULT_JOB_TTL_MS;
}

function jobCheckMs() {
  const configured = Number(process.env.CODEX_AI_BRIDGE_JOB_CHECK_MS);
  if (Number.isInteger(configured) && configured >= 10000) return configured;
  return DEFAULT_JOB_CHECK_MS;
}

function startJobMonitor(job) {
  job.monitor = setInterval(() => {
    if (job.status === "running") markJobChecked(job);
  }, job.checkIntervalMs);
  if (typeof job.monitor.unref === "function") job.monitor.unref();
}

function stopJobMonitor(job) {
  if (!job || !job.monitor) return;
  clearInterval(job.monitor);
  job.monitor = null;
}

function markJobChecked(job, details = {}) {
  if (!job) return;
  job.lastCheckedAt = new Date().toISOString();
  if (details.pid) {
    job.pid = details.pid;
    if (!job.providerStartedAt) job.providerStartedAt = new Date().toISOString();
  }
}

function normalizeOutcome(result, provider) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: true, status: "completed", text: String(result || `${provider} result:\n(no output)`) };
  }
  const ok = result.ok !== false;
  return {
    ok,
    status: ok ? "completed" : (result.status === "timeout" ? "timeout" : "failed"),
    text: String(result.text || (ok ? `${provider} result:\n(no output)` : `${provider} failed`)),
    failureKind: result.failureKind,
    pid: result.pid,
    elapsedMs: result.elapsedMs
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

module.exports = {
  startJob,
  waitForJob,
  formatJobPending,
  formatJobStatus,
  getJob,
  markJobChecked
};
