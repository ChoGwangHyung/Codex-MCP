#!/usr/bin/env node
"use strict";

const { handleMessage, main, tools } = require("./server.js");

if (require.main === module) {
  main();
}

module.exports = {
  _test: {
    handleMessage,
    tools
  }
};
