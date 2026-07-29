"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCommand, terminateAllChildren } = require("../src/runner.js");

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

  const bareCommandWithQuotedArgs = await runCommand("node", ["-e", "process.stdout.write(process.argv[1])", "quoted arg"], {
    cwd: process.cwd(),
    timeoutMs: 5000,
    input: ""
  });
  assert.equal(bareCommandWithQuotedArgs.ok, true);
  assert.equal(bareCommandWithQuotedArgs.stdout, "quoted arg");

  const concurrentBareCommands = await Promise.all([
    runCommand("node", ["-e", "setTimeout(() => process.stdout.write('a'), 100)"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      input: ""
    }),
    runCommand("node", ["-e", "setTimeout(() => process.stdout.write('b'), 100)"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
      input: ""
    })
  ]);
  assert.deepEqual(concurrentBareCommands.map((result) => result.ok), [true, true]);
  assert.deepEqual(concurrentBareCommands.map((result) => result.stdout).sort(), ["a", "b"]);

  const timeout = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 500,
    input: ""
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.timedOut, true);
  assert.equal(typeof timeout.pid, "number");
  assert.ok(timeout.elapsedMs >= 0);

  const stubborn = await runCommand(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    {
      cwd: process.cwd(),
      timeoutMs: 1000,
      input: ""
    }
  );
  assert.equal(stubborn.ok, false);
  assert.equal(stubborn.timedOut, true);
  assert.ok(stubborn.elapsedMs < 5000, "a provider that ignores SIGTERM is force-killed");

  const running = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 0,
    input: ""
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await terminateAllChildren();
  const terminated = await running;
  assert.equal(terminated.ok, false);

  if (process.platform === "win32") {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ai-runner-"));
    const shimDir = path.join(temp, "shim dir");
    const shim = path.join(shimDir, "bridge-test.cmd");
    try {
      fs.mkdirSync(shimDir);
      fs.writeFileSync(shim, "@echo off\r\nnode -e \"process.stdout.write(process.argv[1] || '')\" \"%~1\"\r\n");
      const shimResult = await runCommand(shim, ["100%done"], {
        cwd: process.cwd(),
        timeoutMs: 5000,
        input: ""
      });
      assert.equal(shimResult.ok, true, shimResult.stderr || shimResult.error);
      assert.equal(shimResult.stdout, "100%done");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
