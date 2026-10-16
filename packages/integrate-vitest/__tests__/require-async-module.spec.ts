import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

/**
 * `require()` of an ES module with top-level await is Node.js'
 * `ERR_REQUIRE_ASYNC_MODULE`, which code catches to fall back to `import()`. The
 * `pirates` hook compiles a `require()`d ES module to CommonJS, which cannot express
 * top-level await, and used to fail with a bare transform error instead (issue #842).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-require-async-"));
  roots.push(root);
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

const TLA = "await Promise.resolve();\nexport const v: string = 'esm';\n";

test("require() of an ES module with top-level await is ERR_REQUIRE_ASYNC_MODULE", () => {
  const root = fixture({
    "package.json": JSON.stringify({ private: true }),
    "dep.mts": TLA,
    "dep.mjs": "await Promise.resolve();\nexport const v = 'esm';\n",
    "for-await.mts": "for await (const x of [1]) {}\nexport const v: string = 'esm';\n",
    "outer.mts": "export { v } from './dep.mts';\n",
    "esm/package.json": JSON.stringify({ type: "module" }),
    "esm/dep.ts": TLA,
    "untyped/dep.ts": "await Promise.resolve();\nconst v: string = 'esm';\n",
    "no-tla.mts": "export async function f() { await 1; }\nexport const v: string = 'sync';\n",
    "main.cts": [
      "const specifiers = ['./dep.mts', './dep.mjs', './for-await.mts', './outer.mts', './esm/dep.ts', './untyped/dep.ts'];",
      "for (const specifier of specifiers) {",
      "  try { require(specifier); console.log(specifier, 'loaded'); }",
      "  catch (error) { console.log(specifier, (error as { code: string }).code); }",
      "}",
      "console.log('./no-tla.mts', require('./no-tla.mts').v);",
      "import('./dep.mts').then((m) => console.log('import()', m.v));",
    ].join("\n"),
  });
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "./main.cts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
      timeout: 30_000,
    },
  );
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    [
      "./dep.mts ERR_REQUIRE_ASYNC_MODULE",
      "./dep.mjs ERR_REQUIRE_ASYNC_MODULE",
      "./for-await.mts ERR_REQUIRE_ASYNC_MODULE",
      "./outer.mts ERR_REQUIRE_ASYNC_MODULE",
      "./esm/dep.ts ERR_REQUIRE_ASYNC_MODULE",
      "./untyped/dep.ts ERR_REQUIRE_ASYNC_MODULE",
      "./no-tla.mts sync",
      "import() esm",
      "",
    ].join("\n"),
  );
});

test("a CommonJS file's top-level await is not reported as an ES module's", () => {
  const root = fixture({
    "package.json": JSON.stringify({ private: true, type: "commonjs" }),
    "dep.ts": "await Promise.resolve();\nconst v: string = 'cjs';\n",
    "main.cts":
      "try { require('./dep.ts'); } catch (error) { console.log((error as { code: string }).code); }\n",
  });
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "./main.cts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
      timeout: 30_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("ERR_REQUIRE_ASYNC_MODULE");
});
