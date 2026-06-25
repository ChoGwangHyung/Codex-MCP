"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-configure-project-"));
const projectDir = path.join(tempDir, "project");
const codexHome = path.join(tempDir, "codex-home");
const script = path.join(__dirname, "..", "scripts", "telegram-configure.js");
fs.mkdirSync(projectDir, { recursive: true });

const run = () => childProcess.execFileSync(process.execPath, [script, "install-project"], {
  cwd: projectDir,
  env: { ...process.env, CODEX_HOME: codexHome },
  encoding: "utf8"
});

const first = run();
assert.match(first, /mcp_config: updated/);

const configFile = path.join(projectDir, ".codex", "config.toml");
const envFile = path.join(projectDir, ".codex", "config.toml.env");
const accessFile = path.join(projectDir, ".codex", "config.toml.access.json");
const gitignoreFile = path.join(projectDir, ".codex", ".gitignore");

assert.equal(fs.existsSync(configFile), true);
assert.equal(fs.existsSync(envFile), true);
assert.equal(fs.existsSync(accessFile), true);
assert.equal(fs.existsSync(gitignoreFile), true);

const config = fs.readFileSync(configFile, "utf8");
assert.match(config, /\[features]/);
assert.match(config, /hooks = true/);
assert.match(config, /# BEGIN codex-telegram-bridge-mcp server/);
assert.match(config, /\[mcp_servers\.codex-telegram-bridge]/);
assert.match(config, /CODEX_TELEGRAM_BRIDGE_ENV_FILE/);
assert.match(config, /# BEGIN codex-telegram-bridge-mcp permission hook/);
assert.match(config, /\[\[hooks\.PermissionRequest]]/);
assert.match(config, /\[\[hooks\.PostToolUse]]/);
assert.match(config, /\[\[hooks\.Stop]]/);
assert.doesNotMatch(config, /CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR/);
assert.doesNotMatch(config, /CODEX_TELEGRAM_BRIDGE_ACCESS_FILE/);

const env = fs.readFileSync(envFile, "utf8");
assert.match(env, /^CODEX_TELEGRAM_BRIDGE_ENABLED=1$/m);
assert.match(env, /^CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE=local$/m);
assert.doesNotMatch(env, /TELEGRAM_ALLOWED_CHAT_IDS/);
assert.doesNotMatch(env, /CODEX_TELEGRAM_BRIDGE_RUNTIME_DIR/);
assert.doesNotMatch(env, /CODEX_TELEGRAM_BRIDGE_DOWNLOAD_DIR/);

const access = JSON.parse(fs.readFileSync(accessFile, "utf8"));
assert.deepEqual(access.allowFrom, []);
assert.equal(access.dmPolicy, "allowlist");

const gitignore = fs.readFileSync(gitignoreFile, "utf8");
assert.match(gitignore, /# BEGIN codex-telegram-bridge-mcp local files/);
assert.match(gitignore, /^config\.toml\.env$/m);
assert.match(gitignore, /^config\.toml\.access\.json$/m);
assert.match(gitignore, /^telegram-runtime\/$/m);

const second = run();
assert.match(second, /mcp_config: already current/);
const repeated = fs.readFileSync(configFile, "utf8");
assert.equal((repeated.match(/BEGIN codex-telegram-bridge-mcp server/g) || []).length, 1);
assert.equal((repeated.match(/BEGIN codex-telegram-bridge-mcp permission hook/g) || []).length, 1);
const repeatedGitignore = fs.readFileSync(gitignoreFile, "utf8");
assert.equal((repeatedGitignore.match(/BEGIN codex-telegram-bridge-mcp local files/g) || []).length, 1);

const existingDir = path.join(tempDir, "existing");
fs.mkdirSync(path.join(existingDir, ".codex"), { recursive: true });
fs.writeFileSync(path.join(existingDir, ".codex", "config.toml"), [
  "[mcp_servers.codex-telegram-bridge]",
  'command = "codex-telegram-bridge-mcp"',
  ""
].join("\n"));
childProcess.execFileSync(process.execPath, [script, "install-project"], {
  cwd: existingDir,
  env: { ...process.env, CODEX_HOME: codexHome },
  encoding: "utf8"
});
const existingConfig = fs.readFileSync(path.join(existingDir, ".codex", "config.toml"), "utf8");
assert.equal((existingConfig.match(/\[mcp_servers\.codex-telegram-bridge]/g) || []).length, 1);
assert.equal((existingConfig.match(/BEGIN codex-telegram-bridge-mcp server/g) || []).length, 0);
assert.equal((existingConfig.match(/BEGIN codex-telegram-bridge-mcp permission hook/g) || []).length, 1);

const quotedExistingDir = path.join(tempDir, "quoted-existing");
fs.mkdirSync(path.join(quotedExistingDir, ".codex"), { recursive: true });
fs.writeFileSync(path.join(quotedExistingDir, ".codex", "config.toml"), [
  '[mcp_servers."codex-telegram-bridge"]',
  'command = "codex-telegram-bridge-mcp"',
  ""
].join("\n"));
childProcess.execFileSync(process.execPath, [script, "install-project"], {
  cwd: quotedExistingDir,
  env: { ...process.env, CODEX_HOME: codexHome },
  encoding: "utf8"
});
const quotedExistingConfig = fs.readFileSync(path.join(quotedExistingDir, ".codex", "config.toml"), "utf8");
assert.equal((quotedExistingConfig.match(/\[mcp_servers\."codex-telegram-bridge"]/g) || []).length, 1);
assert.equal((quotedExistingConfig.match(/BEGIN codex-telegram-bridge-mcp server/g) || []).length, 0);
assert.equal((quotedExistingConfig.match(/BEGIN codex-telegram-bridge-mcp permission hook/g) || []).length, 1);

const globalDir = path.join(tempDir, "global-hook");
const globalHome = path.join(tempDir, "global-home");
fs.mkdirSync(path.join(globalDir, ".codex"), { recursive: true });
fs.mkdirSync(globalHome, { recursive: true });
fs.writeFileSync(path.join(globalHome, "config.toml"), [
  "# BEGIN codex-telegram-bridge-mcp permission hook",
  "[[hooks.Stop]]",
  'matcher = "*"',
  "# END codex-telegram-bridge-mcp permission hook",
  ""
].join("\n"));
childProcess.execFileSync(process.execPath, [script, "install-project"], {
  cwd: globalDir,
  env: { ...process.env, CODEX_HOME: globalHome },
  encoding: "utf8"
});
const globalEnv = fs.readFileSync(path.join(globalDir, ".codex", "config.toml.env"), "utf8");
const globalConfig = fs.readFileSync(path.join(globalDir, ".codex", "config.toml"), "utf8");
assert.doesNotMatch(globalEnv, /CODEX_TELEGRAM_PERMISSION_HOOK_SCOPE=local/);
assert.equal((globalConfig.match(/BEGIN codex-telegram-bridge-mcp permission hook/g) || []).length, 0);
