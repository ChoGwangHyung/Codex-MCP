"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-telegram-inbound-media-"));

process.env.CODEX_TELEGRAM_BRIDGE_ENABLED = "1";
process.env.CODEX_TELEGRAM_MONITOR_ENABLED = "0";
process.env.TELEGRAM_BOT_TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "12345";
process.env.CODEX_TELEGRAM_BRIDGE_STATE_FILE = path.join(tempDir, "telegram-state.json");
process.env.CODEX_TELEGRAM_BRIDGE_DOWNLOAD_DIR = path.join(tempDir, "downloads");

const originalFetch = global.fetch;
const calls = [];
const fileBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

global.fetch = async (url, options) => {
  const href = String(url);
  const method = href.split("/").pop();
  calls.push({ url: href, method, options });

  if (method === "getFile") {
    const payload = JSON.parse(options.body || "{}");
    assert.equal(payload.file_id, "photo-large");
    return telegramResponse({
      file_id: "photo-large",
      file_unique_id: "photo-unique",
      file_size: fileBytes.length,
      file_path: "photos/file_1.jpg"
    });
  }

  if (href.includes("/file/bot")) {
    return {
      ok: true,
      headers: {
        get: (name) => String(name).toLowerCase() === "content-length" ? String(fileBytes.length) : null
      },
      arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength)
    };
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
  const { _test } = require("../src/telegram.js");

  const messages = await _test.buildAllowedMessages([{
    update_id: 10,
    message: {
      message_id: 20,
      date: 1778371200,
      chat: { id: 12345 },
      from: { id: 777, username: "tester" },
      caption: "check this photo",
      photo: [
        { file_id: "photo-small", file_unique_id: "small", file_size: 1, width: 64, height: 64 },
        { file_id: "photo-large", file_unique_id: "photo-unique", file_size: fileBytes.length, width: 1280, height: 720 }
      ]
    }
  }]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, "12345");
  assert.match(messages[0].text, /check this photo/);
  assert.match(messages[0].text, /Attachment: photo/);
  assert.match(messages[0].text, /Local file:/);
  assert.match(messages[0].text, /10-20-photo-file_1\.jpg/);
  assert.doesNotMatch(messages[0].text, /Telegram file_id/);
  assert.doesNotMatch(messages[0].text, /photo-large/);
  assert.doesNotMatch(messages[0].text, /MIME type:/);
  assert.equal(messages[0].attachments.length, 1);
  assert.equal(messages[0].attachments[0].type, "photo");
  assert.equal(messages[0].attachments[0].fileId, "photo-large");
  assert.equal(messages[0].attachments[0].fileSize, fileBytes.length);
  assert.equal(fs.readFileSync(messages[0].attachments[0].localPath).compare(fileBytes), 0);
  assert.deepEqual(calls.map((call) => call.method), ["getFile", "file_1.jpg"]);
})().finally(() => {
  global.fetch = originalFetch;
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
