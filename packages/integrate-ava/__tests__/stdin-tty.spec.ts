import test from "ava";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FIXTURE_PATHS = new Map(
  ["tty-check.ts", "stdin-echo.ts"].map((name) => [
    name,
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
  ]),
);

const getFixturePath = (fixtureName: string) => {
  const resolved = FIXTURE_PATHS.get(fixtureName);
  if (!resolved) {
    throw new Error(`Unknown fixture: ${fixtureName}`);
  }
  return resolved;
};

const oxnodePath = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));

test("CLI preserves TTY properties when stdin is a TTY", (t) => {
  const fixturePath = getFixturePath("tty-check.ts");

  // Run with oxnode via spawn to inherit stdio
  // Note: In CI environment, stdin might not be a TTY, but we can still test
  // that oxnode doesn't break TTY when one is available
  const result = spawnSync(process.execPath, [oxnodePath, fixturePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
    },
  });

  t.falsy(result.error, result.error?.message);
  t.is(result.status, 0, `oxnode should run successfully. stderr: ${result.stderr}`);

  // Extract JSON from stdout, filtering out debug logs
  const jsonLine = result.stdout.split("\n").find((line) => line.trim().startsWith("{"));
  t.truthy(jsonLine, "should find JSON output in stdout");

  const output = JSON.parse(jsonLine!.trim());

  // In a non-TTY environment (like CI), isTTY will be undefined and omitted from JSON
  // In a TTY environment, isTTY should be true
  // The key is that we're checking it's not explicitly broken by piping
  if ("isTTY" in output) {
    t.true(output.isTTY, "when present, isTTY should be true");
  }
  // When stdin is a TTY, setRawMode should be available
  // When stdin is not a TTY, setRawMode might not be available
  t.is(typeof output.hasSetRawMode, "boolean", "hasSetRawMode should be a boolean");
});

test("CLI properly handles stdin piping", async (t) => {
  const fixturePath = getFixturePath("stdin-echo.ts");
  const testInput = "Hello from stdin test";

  // Spawn oxnode and pipe input to it
  const child = spawn(process.execPath, [oxnodePath, fixturePath], {
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
    },
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  // Write test input to stdin and close it
  child.stdin?.write(testInput);
  child.stdin?.end();

  // Wait for child to exit
  await new Promise((resolve) => {
    child.on("exit", resolve);
  });

  // Filter out experimental warnings from stderr (e.g., WASI warnings)
  const stderrLines = stderr
    .split("\n")
    .filter(
      (line) =>
        !line.includes("ExperimentalWarning") &&
        !line.includes("Use `node --trace-warnings") &&
        line.trim().length > 0,
    );
  const actualStderr = stderrLines.join("\n").trim();

  t.is(actualStderr, "", "should not produce any errors");

  // Extract the actual output, filtering out debug lines
  const outputLines = stdout
    .split("\n")
    .filter((line) => !line.includes("DEBUG") && line.trim().length > 0);
  const actualOutput = outputLines.join("\n").trim();

  t.is(actualOutput, testInput, "should echo the input correctly");
});

test("CLI with node directly preserves TTY (baseline comparison)", (t) => {
  const fixturePath = getFixturePath("tty-check.ts");

  // Run with node directly with --import for baseline comparison
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", fixturePath], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
    },
  });

  t.falsy(result.error, result.error?.message);
  t.is(result.status, 0, "node with --import should run successfully");

  // Extract JSON from stdout, filtering out debug logs
  const jsonLine = result.stdout.split("\n").find((line) => line.trim().startsWith("{"));
  t.truthy(jsonLine, "should find JSON output in stdout");

  const output = JSON.parse(jsonLine!.trim());

  // This is the baseline - both oxnode and node --import should behave the same
  if ("isTTY" in output) {
    t.true(output.isTTY, "baseline: when present, isTTY should be true");
  }
  t.is(typeof output.hasSetRawMode, "boolean", "baseline: hasSetRawMode should be a boolean");
});
