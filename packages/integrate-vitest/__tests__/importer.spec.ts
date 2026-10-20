import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

/**
 * `@oxc-node/core/importer` (issue #173) is checked against the jiti v2 behaviour it
 * copies: the parity checks run from an ES module host and from a CommonJS host, each
 * under plain `node`, and every graded check has to pass. The probes cover what the
 * checks do not — stack lines, `require()` of ES modules, cycles, memory and leaks.
 */
const FIXTURE = fileURLToPath(new URL("fixtures/importer", import.meta.url));
// Through the package's `exports`, as a tool would load it; a CommonJS host gets the same
// file through require(esm).
const IMPORTER = createRequire(import.meta.url).resolve("@oxc-node/core/importer");
// The parity checks, `info-*` rows aside.
const GRADED_CHECKS = 64;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "oxc-node-importer-"));
  cpSync(FIXTURE, root, { recursive: true });
  // Kept as `deps` in the repository, where `node_modules` is ignored.
  renameSync(join(root, "project", "deps"), join(root, "project", "node_modules"));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

interface Row {
  check: string;
  ok: boolean;
  detail: string;
}

function run(script: string, ...flags: string[]): Row[] {
  const result = spawnSync(process.execPath, [...flags, join(root, script), IMPORTER], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
    timeout: 50_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Row);
}

function failures(rows: Row[]): string[] {
  return rows
    .filter((row) => !row.ok && !row.check.startsWith("info-"))
    .map((row) => `${row.check}: ${row.detail}`);
}

test.each(["host.mjs", "host.cjs"])("every jiti parity check passes from %s", (host) => {
  const rows = run(host);
  expect(failures(rows)).toEqual([]);
  expect(rows.filter((row) => !row.check.startsWith("info-"))).toHaveLength(GRADED_CHECKS);
});

test("the importer probes pass", () => {
  const rows = run("probes.mjs", "--expose-gc");
  expect(failures(rows)).toEqual([]);
  expect(rows.map((row) => row.check)).toEqual([
    "stack-line-after-import",
    "stack-mapped-escaping-import",
    "cts-requires-esm-ts",
    "cts-requires-esm-graph",
    "require-tla-is-async-module-error",
    "require-cached-tla-is-async-module-error",
    "require-cached-native-tla-is-async-module-error",
    "default-and-namespace-import",
    "require-evaluating-tla-is-async-module-error",
    "cycle",
    "parallel-cycle",
    "live-binding",
    "export-star",
    "export-star-ambiguous",
    "import-meta-resolve-missing",
    "directory-parent-paths",
    "package-path-not-exported",
    "package-path-exported-for-require-only",
    "new-Function-import",
    "lazy-import-after-return",
    "failed-module-retried",
    "hashbang",
    "memory-module-cache-false",
    "memory-module-cache-false-new-files",
    "memory-failed-new-files",
    "memory-failed-caught-new-files",
    "no-leak",
  ]);
});
