import test from "ava";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(
  new URL("../../../cli/src/index.ts", import.meta.url),
);
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/write-file-delayed.ts", import.meta.url),
);

test("child process completes before parent exits", (t) => {
  // Create a temporary directory for the test output
  const tmpDir = mkdtempSync(join(tmpdir(), "oxnode-test-"));
  const outputPath = join(tmpDir, "output.txt");

  try {
    // Run the fixture via oxnode CLI
    const result = spawnSync(
      process.execPath,
      ["--import", "@oxc-node/core/register", CLI_PATH, FIXTURE_PATH, outputPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: undefined,
        },
      },
    );

    // The fixture exits with code 0 after writing the file
    t.is(result.status, 0, "Process should exit with code 0");
    t.falsy(result.error, "No spawn error should occur");

    // If the parent doesn't wait for the child, this file won't exist
    t.true(
      existsSync(outputPath),
      "Output file should exist after parent process exits",
    );

    // Verify the file content
    const content = readFileSync(outputPath, "utf8");
    t.is(content, "completed", "File should contain 'completed'");
  } finally {
    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("child process exit code is propagated to parent", (t) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "@oxc-node/core/register",
      CLI_PATH,
      "-e",
      "process.exit(42)",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
      },
    },
  );

  t.is(result.status, 42, "Parent should exit with same code as child");
});
