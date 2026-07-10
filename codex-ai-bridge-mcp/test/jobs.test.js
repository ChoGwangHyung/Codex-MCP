"use strict";

const assert = require("node:assert/strict");
const {
  formatJobStatus,
  startJob,
  waitForJob
} = require("../src/jobs.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const slow = startJob("claude", {
    cwd: process.cwd(),
    timeoutMs: 0
  }, async () => {
    await delay(200);
    return "claude result:\ndone";
  });

  assert.equal(await waitForJob(slow, 20), false);
  assert.match(formatJobStatus(slow.jobId), /status: running/);
  assert.match(formatJobStatus(slow.jobId), /heartbeatIntervalMs:/);
  assert.match(formatJobStatus(slow.jobId), /providerStatus: waiting_for_lock/);
  assert.match(formatJobStatus(slow.jobId), /hardTimeoutMs: disabled/);
  assert.equal(await waitForJob(slow, 1000), true);
  assert.match(formatJobStatus(slow.jobId), /status: completed/);
  assert.match(formatJobStatus(slow.jobId), /claude result:\ndone/);

  const noBudgetLimit = startJob("claude", {
    cwd: process.cwd(),
    timeoutMs: 0
  }, async () => {
    await delay(50);
    return "claude result:\nwaited";
  });
  assert.equal(await waitForJob(noBudgetLimit, 0), true);
  assert.match(formatJobStatus(noBudgetLimit.jobId), /status: completed/);
  assert.match(formatJobStatus(noBudgetLimit.jobId), /claude result:\nwaited/);

  const providerFailure = startJob("claude", {
    cwd: process.cwd(),
    timeoutMs: 10000
  }, async (job) => {
    const { markJobChecked } = require("../src/jobs.js");
    markJobChecked(job, { pid: process.pid });
    return { ok: false, status: "timeout", failureKind: "hard_timeout", text: "claude failed: hard timeout", pid: process.pid, elapsedMs: 25 };
  });
  assert.equal(await waitForJob(providerFailure, 1000), true);
  assert.match(formatJobStatus(providerFailure.jobId), /status: timeout/);
  assert.match(formatJobStatus(providerFailure.jobId), /failureKind: hard_timeout/);
  assert.match(formatJobStatus(providerFailure.jobId), /providerElapsedMs: 25/);

  const failed = startJob("gemini", {
    cwd: process.cwd(),
    timeoutMs: 10000
  }, async () => {
    throw new Error("boom");
  });
  assert.match(formatJobStatus(failed.jobId), /hardTimeoutRemainingMs:/);
  assert.equal(await waitForJob(failed, 1000), true);
  assert.match(formatJobStatus(failed.jobId), /gemini failed: boom/);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
