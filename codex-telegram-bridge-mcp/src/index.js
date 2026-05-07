#!/usr/bin/env node
"use strict";

const { main } = require("./server.js");
const {
  relayEnabled,
  relayReplyRequired,
  telegramEnabled
} = require("./config.js");
const {
  formatConsoleRelayPrompt,
  formatRelayPrompt,
  isApprovalDecisionRelayMessage,
  relayReplyInstructionLines
} = require("./relay.js");

if (require.main === module) {
  main();
}

module.exports = {
  _test: {
    formatRelayPrompt,
    formatConsoleRelayPrompt,
    isApprovalDecisionRelayMessage,
    relayReplyInstructionLines,
    relayEnabled,
    relayReplyRequired,
    telegramEnabled
  }
};
