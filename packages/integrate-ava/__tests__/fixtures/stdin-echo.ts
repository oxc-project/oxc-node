#!/usr/bin/env node
// Test fixture that reads from stdin and echoes it back
import process from "node:process";

let data = "";

process.stdin.on("data", (chunk) => {
  data += chunk;
});

process.stdin.on("end", () => {
  console.log(data.trim());
});
