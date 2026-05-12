"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-done-notifier-"));
const configFile = path.join(tempDir, "config.toml");
process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE = configFile;
process.env.CODEX_DONE_NOTIFIER_HOOK_COMMAND = "node notifier.js hook";
process.env.CODEX_DONE_NOTIFIER_DRY_RUN = "1";

const { _test } = require("../src/cli.js");

assert.equal(
  _test.ensureCodexHooksFeature("model = \"gpt-5\"\n").trimEnd(),
  "model = \"gpt-5\"\n\n[features]\nhooks = true"
);

assert.equal(
  _test.ensureCodexHooksFeature("[features]\ncodex_hooks = true\nhooks = false\n"),
  "[features]\nhooks = true"
);

const first = _test.ensureHookInstalled();
assert.equal(first.changed, true);
const installed = fs.readFileSync(configFile, "utf8");
assert.match(installed, /\[features]/);
assert.match(installed, /hooks = true/);
assert.match(installed, /\[\[hooks\.Stop]]/);
assert.match(installed, /node notifier\.js hook/);
assert.match(installed, /--enabled --sound exclamation/);
assert.match(installed, /codex-done-notifier-config/);
assert.doesNotMatch(installed, /codex_hooks/);
assert.equal(_test.doneHookStatus().installed, true);
assert.equal(_test.currentNotifierConfig().configured, true);
assert.equal(_test.currentNotifierConfig().enabled, true);
assert.equal(_test.currentNotifierConfig().sound, "exclamation");

const second = _test.ensureHookInstalled();
assert.equal(second.changed, false);

fs.appendFileSync(configFile, `\n[hooks.state.'${configFile}:stop:0:0']\ntrusted_hash = "sha256:abc"\n`);
assert.equal(_test.hookReviewStatus(configFile).reviewed, true);

const cleaned = _test.removeManagedHookBlock(installed);
assert.doesNotMatch(cleaned, /codex-done-notifier hook/);

const stateful = [
  "# BEGIN codex-done-notifier hook",
  "[[hooks.Stop]]",
  'matcher = "*"',
  "",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  'command = "node notifier.js hook"',
  "",
  "[hooks.state]",
  "",
  "[hooks.state.'C:\\Users\\me\\.codex\\config.toml:stop:0:0']",
  'trusted_hash = "sha256:abc"',
  "# END codex-done-notifier hook"
].join("\n");
const statefulCleaned = _test.removeManagedHookBlock(stateful);
assert.doesNotMatch(statefulCleaned, /codex-done-notifier hook/);
assert.match(statefulCleaned, /\[hooks\.state]/);
assert.match(statefulCleaned, /trusted_hash = "sha256:abc"/);

const project = path.join(tempDir, "project");
const nested = path.join(project, "src");
fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
fs.mkdirSync(nested, { recursive: true });
assert.equal(_test.codexConfigPath({ cwd: project }), configFile);
const configuredConfigFile = process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE;
delete process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE;
assert.equal(_test.codexConfigPath({ cwd: project }), path.join(project, ".codex", "config.toml"));
assert.equal(_test.codexConfigPath({ cwd: project, global: true }), path.join(os.homedir(), ".codex", "config.toml"));
process.env.CODEX_DONE_NOTIFIER_CONFIG_FILE = configuredConfigFile;
assert.equal(
  _test.shouldNotify({
    sessionId: "session-1",
    hookConfig: _test.hookConfigFromArgs(["--enabled", "--sound", "exclamation", "--session", "session-1"])
  }),
  true
);
assert.equal(
  _test.shouldNotify({
    sessionId: "session-2",
    hookConfig: _test.hookConfigFromArgs(["--enabled", "--sound", "exclamation", "--session", "session-1"])
  }),
  false
);
assert.equal(_test.normalizeSoundName("ding"), "ding");
assert.equal(_test.normalizeSoundName("exclamation"), "exclamation");
assert.equal(_test.normalizeSoundName("unknown"), "exclamation");
assert.equal(_test.markerSoundEnabled({ sound: "none" }), false);
assert.equal(_test.markerNotificationEnabled({ notificationEnabled: false }), false);
assert.equal(_test.markerHasOutput({ soundEnabled: false, notificationEnabled: false }), false);
assert.equal(
  _test.shouldNotify({
    sessionId: "session-1",
    hookConfig: _test.hookConfigFromArgs(["--enabled", "--no-sound", "--no-notification"])
  }),
  false
);
assert.equal(_test.notificationSound({ sound: "hand" }), "hand");
assert.equal(_test.notificationSound({ soundEnabled: false, sound: "hand" }), "none");
assert.equal(
  _test.notificationSoundFile({ soundFile: ".codex/done.wav" }),
  path.resolve(".codex", "done.wav")
);
assert.equal(
  _test.notificationSoundFile({ soundFile: path.join(project, "done.wav") }),
  path.join(project, "done.wav")
);
assert.match(_test.windowsDefaultSoundFile("ding"), /ding\.wav$/i);

process.env.CODEX_DONE_NOTIFIER_ENABLED = "1";
assert.equal(_test.shouldNotify({ sessionId: "" }), true);
delete process.env.CODEX_DONE_NOTIFIER_ENABLED;

process.env.CODEX_DONE_NOTIFIER_SESSION_IDS = "a,b c";
assert.equal(_test.shouldNotify({ sessionId: "b" }), true);
assert.equal(_test.shouldNotify({ sessionId: "d" }), false);
delete process.env.CODEX_DONE_NOTIFIER_SESSION_IDS;

assert.equal(
  _test.notificationBody({
    last_assistant_message: "Done.\nExtra",
    cwd: project
  }, project),
  "project: Done."
);

_test.handleHookInput({
  cwd: project,
  session_id: "session-1",
  last_assistant_message: "Finished"
}, _test.hookConfigFromArgs(["--enabled", "--sound", "exclamation", "--session", "session-1"])).then((result) => {
  assert.equal(result.notified, true);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
