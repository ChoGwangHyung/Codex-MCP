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

  const timeout = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 500,
    input: ""
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
