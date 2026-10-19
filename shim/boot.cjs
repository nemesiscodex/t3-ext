"use strict";

const path = require("node:path");
const { originalMain } = require("./patch.json");

try {
  require("./host.cjs").start();
} catch (error) {
  console.error("[t3ext] extension host failed to start; continuing without extensions", error);
}

require(path.join(__dirname, "..", originalMain));
