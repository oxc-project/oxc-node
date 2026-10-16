import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Parse and transform errors used to report only the message — `Failed to parse
 * …/main.ts: Unexpected token` — with no line, column or code frame, so in a large
 * file there was no way to find the error (issue #839). Each diagnostic now renders
 * as a colorless report: a `path:line:column` header and the offending lines.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-diagnostics-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
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

const ENV = {
  ...process.env,
  NODE_OPTIONS: undefined,
  OXC_LOG: undefined,
  TS_NODE_PROJECT: undefined,
  OXC_TSCONFIG_PATH: undefined,
};

function run(root: string, entry: string): string {
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry], {
    cwd: root,
    encoding: "utf8",
    env: ENV,
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).not.toBe(0);
  return result.stderr;
}

const BROKEN = "const ok = 1;\nconsole.log(ok);\nconst broken: number = ;\n";

describe("diagnostics name the line and column", () => {
  test("parse error in an ES module", () => {
    const root = fixture({ "main.ts": BROKEN });
    const stderr = run(root, "./main.ts");
    expect(stderr).toContain("x Unexpected token");
    expect(stderr).toMatch(/main\.ts:3:24\]/);
    expect(stderr).toContain(" 3 | const broken: number = ;");
  });

  test("parse error in a CommonJS module loaded through require", () => {
    const root = fixture({ "entry.cjs": 'require("./broken.cts");\n', "broken.cts": BROKEN });
    const stderr = run(root, "./entry.cjs");
    expect(stderr).toContain("Failed to parse");
    expect(stderr).toMatch(/broken\.cts:3:24\]/);
    expect(stderr).toContain(" 3 | const broken: number = ;");
  });

  test("the file is named by its path, not its percent-encoded URL", () => {
    const root = fixture({ "sub dir/main.ts": BROKEN });
    const stderr = run(root, "./sub dir/main.ts");
    expect(stderr).toMatch(/sub dir[\\/]main\.ts:3:24\]/);
  });

  test("transform error", () => {
    const root = fixture({ "main.mts": "const ok = 1;\nexport = ok;\n" });
    const stderr = run(root, "./main.mts");
    expect(stderr).toContain("Failed to transform");
    expect(stderr).toContain("TS(1203)");
    expect(stderr).toMatch(/main\.mts:2:1\]/);
    expect(stderr).toContain(" 2 | export = ok;");
  });
});
