"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-media-"));
const uploadPath = path.join(tempDir, "report.txt");
fs.writeFileSync(uploadPath, "hello from codex", "utf8");

process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");

const originalFetch = global.fetch;
const calls = [];

global.fetch = async (url, options) => {
  const method = String(url).split("/").pop();
  calls.push({ method, options });

  if (method === "sendDocument") {
    if (typeof options.body.get === "function") {
      const form = options.body;
      assert.equal(form.get("chat_id"), "12345");
      assert.equal(form.get("caption"), "report");
      const document = form.get("document");
      assert.equal(document.name, "report.txt");
      assert.equal(document.type, "text/plain");
      assert.equal(await document.text(), "hello from codex");
    } else {
      const payload = JSON.parse(options.body || "{}");
      assert.equal(payload.document, "123456:abcdefghijklmnopqrstuvwxyz");
    }
    return telegramResponse({ message_id: 77 });
  }

  if (method === "sendPhoto") {
    const payload = JSON.parse(options.body || "{}");
    assert.equal(payload.chat_id, "12345");
    assert.equal(payload.photo, "https://example.com/photo.jpg");
    assert.equal(payload.caption, "photo");
    return telegramResponse({ message_id: 88 });
  }

  return telegramResponse(true);
};

function telegramResponse(result) {
  return {
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

(async () => {
  const { telegramSendFile, telegramSendPhoto } = require("../src/telegram.js");

  const documentResult = JSON.parse(await telegramSendFile({
    path: uploadPath,
    caption: "report"
  }));
  assert.equal(documentResult.status, "sent");
  assert.equal(documentResult.type, "file");
  assert.equal(documentResult.source, "path");
  assert.equal(documentResult.chatId, "12345");
  assert.equal(documentResult.messageId, 77);
  assert.equal(documentResult.fileName, "report.txt");
  assert.equal(documentResult.fileSize, 16);

  const photoResult = JSON.parse(await telegramSendPhoto({
    url: "https://example.com/photo.jpg",
    caption: "photo"
  }));
  assert.equal(photoResult.status, "sent");
  assert.equal(photoResult.type, "photo");
  assert.equal(photoResult.source, "url");
  assert.equal(photoResult.messageId, 88);
  assert.equal(photoResult.fileName, "photo.jpg");

  const fileIdResult = JSON.parse(await telegramSendFile({
    fileId: "123456:abcdefghijklmnopqrstuvwxyz"
  }));
  assert.equal(fileIdResult.status, "sent");
  assert.equal(fileIdResult.source, "file_id");

  await assert.rejects(
    () => telegramSendPhoto({ path: uploadPath, url: "https://example.com/photo.jpg" }),
    /only one of path, url, or fileId may be provided/
  );

  await assert.rejects(
    () => telegramSendPhoto({}),
    /one of path, url, or fileId is required/
  );

  assert.deepEqual(calls.map((call) => call.method), ["sendDocument", "sendPhoto", "sendDocument"]);
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
