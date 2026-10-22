import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Node.js resolves `--import` preloads from the working directory as a directory URL,
 * `pathToFileURL(cwd + "/")`. That parent URL was read as a file, so the resolve ran
 * from the directory above: `--import ./setup` missed `setup.ts`, and with the working
 * directory at `/` the parent `file:///` had no directory above it at all, which failed
 * every preload with "Parent URL is not a file URL" (issue #862).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));
const REGISTER = pathToFileURL(join(CORE, "register.mjs")).href;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-dir-parent-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(
    CORE,
    join(root, "node_modules", "@oxc-node", "core"),
    // `junction` is the only link type Windows allows without elevated privileges.
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const typed = (label: string) =>
  `const label: string = ${JSON.stringify(label)};\nconsole.log(label);\n`;

describe("a preload resolved from the working directory", () => {
  test("an --import without an extension finds the .ts file", () => {
    const root = fixture({ "setup.ts": typed("setup"), "main.ts": typed("main") });
    const args = ["--import", "@oxc-node/core/register", "--import", "./setup", "./main.ts"];
    expect(run(root, args)).toBe("setup\nmain\n");
  });

  test("an --import without an extension below the working directory", () => {
    const root = fixture({ "lib/setup.ts": typed("lib setup"), "main.ts": typed("main") });
    const args = ["--import", "@oxc-node/core/register", "--import", "./lib/setup", "./main.ts"];
    expect(run(root, args)).toBe("lib setup\nmain\n");
  });

  test("the working directory at the root of the file system", () => {
    const root = fixture({ "setup.ts": typed("setup"), "main.ts": typed("main") });
    const args = ["--import", REGISTER, "--import", join(root, "setup.ts"), join(root, "main.ts")];
    expect(run(parse(root).root, args)).toBe("setup\nmain\n");
  });

  test("an --import ./setup.js runs setup.js, not setup.ts beside it (issue #878)", () => {
    const root = fixture({
      "setup.js": "console.log('setup js');\n",
      "setup.ts": typed("setup ts"),
      "main.ts": typed("main"),
    });
    const args = ["--import", "@oxc-node/core/register", "--import", "./setup.js", "./main.ts"];
    expect(run(root, args)).toBe("setup js\nmain\n");
  });
});
