"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { _test } = require("../src/providers.js");
const { validateMaxOutputChars } = require("../src/config.js");
const { DEFAULT_MAX_RESULT_CHARS, FAILURE_TAIL_CHARS } = require("../src/constants.js");

const { clampResult, tailOutput } = _test;

{
  const short = "a".repeat(100);
  assert.equal(clampResult(short, 500), short, "under-budget output is untouched");
}

{
  const long = `${"h".repeat(5000)}${"t".repeat(5000)}`;
  const clamped = clampResult(long, 1000);
  assert.ok(clamped.length < long.length, "over-budget output shrinks");
  assert.ok(clamped.length <= 1000, "the notice is included in the result budget");
  assert.match(clamped, /chars omitted/, "truncation is announced");
  assert.ok(clamped.startsWith("h"), "head is kept");
  assert.ok(clamped.endsWith("t"), "tail is kept");
  assert.equal(clampResult("abcdef", 1), "a", "tiny budgets still return useful provider text");
}

{
  const long = "x".repeat(50000);
  assert.equal(clampResult(long, 0), long, "0 disables trimming");
  assert.equal(clampResult(long, undefined), long, "a missing budget disables trimming");
}

{
  const noisy = "e".repeat(FAILURE_TAIL_CHARS * 3);
  const tail = tailOutput(noisy);
  assert.ok(tail.length < noisy.length, "failure tails are trimmed");
  assert.ok(tail.length <= FAILURE_TAIL_CHARS, "the notice is included in the failure budget");
  assert.match(tail, /^\[trimmed \d+ of \d+ chars\]/, "trimming is announced");
}

assert.equal(validateMaxOutputChars(undefined), DEFAULT_MAX_RESULT_CHARS);
assert.equal(validateMaxOutputChars(0), 0);
assert.equal(validateMaxOutputChars(5000), 5000);
assert.throws(() => validateMaxOutputChars(-1), /maxOutputChars/);
assert.throws(() => validateMaxOutputChars(1.5), /maxOutputChars/);
assert.throws(() => validateMaxOutputChars(10 ** 9), /maxOutputChars/);

{
  const constantsFile = require.resolve("../src/constants.js");
  const probe = spawnSync(
    process.execPath,
    ["-e", "const value = require(process.argv[1]).DEFAULT_MAX_RESULT_CHARS; process.stdout.write(String(value));", constantsFile],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_AI_BRIDGE_MAX_RESULT_CHARS: "5000" }
    }
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, "5000", "the environment result budget loads without a module initialization error");
}
