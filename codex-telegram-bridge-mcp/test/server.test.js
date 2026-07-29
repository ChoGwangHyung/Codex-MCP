"use strict";

const assert = require("node:assert/strict");

process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "0";
process.env.CODEX_TELEGRAM_PERMISSION_HOOK_AUTO_INSTALL = "0";

const { handleMessage, tools } = require("../src/server.js");

(async () => {
  const initialized = await handleMessage({
    method: "initialize",
    params: { protocolVersion: "2099-01-01" }
  });
  assert.equal(initialized.protocolVersion, "2024-11-05");

  const invalidSend = await handleMessage({
    method: "tools/call",
    params: { name: "telegram_send", arguments: {} }
  });
  assert.equal(invalidSend.isError, true);

  const ask = tools.find((tool) => tool.name === "telegram_ask");
  assert.ok(Array.isArray(ask.inputSchema.oneOf));
  assert.equal(ask.inputSchema.oneOf.length, 3);

  const media = tools.find((tool) => tool.name === "telegram_send_file");
  assert.ok(Array.isArray(media.inputSchema.oneOf));
  assert.deepEqual(
    media.inputSchema.oneOf.map((schema) => schema.required[0]).sort(),
    ["fileId", "path", "url"]
  );
})();
