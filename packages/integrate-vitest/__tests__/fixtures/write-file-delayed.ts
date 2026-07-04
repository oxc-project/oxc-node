import { writeFileSync } from "node:fs";

// This fixture writes a file after a small delay to test that
// the parent process waits for the child to complete
const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("Output path argument is required");
}

// Simulate some async work
setTimeout(() => {
  writeFileSync(outputPath, "completed", "utf8");
  process.exit(0);
}, 100);
