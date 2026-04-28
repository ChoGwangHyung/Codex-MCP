"use strict";

const assert = require("node:assert/strict");
const { runCommand } = require("../src/runner.js");

(async () => {
  const echo = await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    cwd: process.cwd(),
    timeoutMs: 5000,
    input: "hello"
  });
  assert.equal(echo.ok, true);
  assert.equal(echo.stdout, "hello");
  assert.equal(echo.timedOut, false);
  assert.equal(typeof echo.pid, "number");
  assert.equal(typeof echo.elapsedMs, "number");

  const noHardTimeout = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
    cwd: process.cwd(),
    timeoutMs: 0,
    input: ""
  });
  assert.equal(noHardTimeout.ok, true);
  assert.equal(noHardTimeout.stdout, "ok");
  assert.equal(noHardTimeout.timedOut, false);

  const timeout = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 500,
    input: ""
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  assert.equal(typeof timeout.pid, "number");
  assert.ok(timeout.elapsedMs >= 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
