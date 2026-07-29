"use strict";

const assert = require("node:assert/strict");
const { handleMessage, tools } = require("../src/server.js");

(async () => {
  const initialized = await handleMessage({
    method: "initialize",
    params: { protocolVersion: "2099-01-01" }
  });
  assert.equal(initialized.protocolVersion, "2024-11-05");

  const invalidTask = await handleMessage({
    method: "tools/call",
    params: { name: "claude_task", arguments: {} }
  });
  assert.equal(invalidTask.isError, true);
  assert.match(invalidTask.content[0].text, /prompt is required/);

  const missingJob = await handleMessage({
    method: "tools/call",
    params: { name: "ai_bridge_job", arguments: { jobId: "missing-job" } }
  });
  assert.equal(missingJob.isError, true);
  assert.match(missingJob.content[0].text, /job not found/);

  const antigravity = tools.find((tool) => tool.name === "antigravity_task");
  assert.deepEqual(antigravity.inputSchema.properties.effort.enum, ["low", "medium", "high"]);

  const crossReview = tools.find((tool) => tool.name === "cross_review");
  assert.deepEqual(
    crossReview.inputSchema.properties.antigravityEffort.enum,
    ["low", "medium", "high"]
  );
})();
