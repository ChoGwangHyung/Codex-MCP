#!/usr/bin/env node
"use strict";

const { main } = require("./server.js");
const {
  relayEnabled,
  relayReplyRequired,
  telegramEnabled
} = require("./config.js");
const {
  formatAppServerRelayInput,
  formatConsoleRelayPrompt,
  formatRelayPrompt,
  isApprovalDecisionRelayMessage
} = require("./relay.js");

if (require.main === module) {
  main();
}

module.exports = {
  _test: {
    formatAppServerRelayInput,
    formatRelayPrompt,
    formatConsoleRelayPrompt,
    isApprovalDecisionRelayMessage,
    relayEnabled,
    relayReplyRequired,
    telegramEnabled
  }
};
