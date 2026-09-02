#!/usr/bin/env node
// Test fixture to check if stdin has TTY properties
import process from "node:process";

// Output stdin.isTTY status
console.log(
  JSON.stringify({
    isTTY: process.stdin.isTTY,
    hasSetRawMode: typeof process.stdin.setRawMode === "function",
  }),
);
