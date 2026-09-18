import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * A `.ts` or `.js` file inside a `"type": "commonjs"` package is reported as
 * `format: "commonjs"`, but oxc-node has no ESM-to-CommonJS downlevel: the module
 * transform only rewrites TypeScript's `import =` / `export =`. A file that actually
 * contains ESM syntax therefore reaches Node.js with its `import` / `export`
 * declarations intact, and Node.js cannot run it as CommonJS:
 *
 * - as an entry point, compilation detects ESM and retries through `require(esm)`,
 *   which is a self-cycle: `ERR_REQUIRE_CYCLE_MODULE`;
 * - as an imported module, `cjs-module-lexer` sees no CommonJS exports, so every
 *   named import fails with `does not provide an export named ...`.
 *
 * Node.js already runs such files as ES modules when they are `require()`d (the
 * retry succeeds when nothing cycles), so the loader says "module" outright for a
 * file that parses as one — same outcome, without detouring through the retry.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-cjs-esm-"));
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

function run(root: string, entry: string): string {
  const result = spawnSync(
    process.execPath,
    // A bare specifier resolves through the symlinked node_modules on every
    // platform, Windows included — an absolute path would not parse as a URL.
    ["--import", "@oxc-node/core/register", entry],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        OXC_LOG: undefined,
        TS_NODE_PROJECT: undefined,
        OXC_TSCONFIG_PATH: undefined,
      },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

const COMMONJS = JSON.stringify({ name: "fx", private: true, type: "commonjs" });

describe("a CommonJS package", () => {
  test("an entry point with ESM syntax runs as an ES module", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "entry.ts": [
        'import { readFileSync } from "node:fs";',
        "export {};",
        'console.log("format:", typeof require === "undefined" ? "module" : "commonjs");',
        'console.log("fs:", typeof readFileSync);',
      ].join("\n"),
    });
    const output = run(root, "./entry.ts");
    expect(output).toContain("format: module");
    expect(output).toContain("fs: function");
  });

  test("an imported module keeps its named exports", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "cjs/package.json": COMMONJS,
      // Reported as CommonJS, but nothing downlevels the `export`, so a CommonJS
      // reading of it has no named exports at all.
      "cjs/dep.ts": 'export const dep = "dep-ok";\n',
      "entry.ts": ['import { dep } from "./cjs/dep.ts";', 'console.log("dep:", dep);'].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("dep: dep-ok");
  });

  test("top-level await in an ESM-syntax file runs", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "entry.ts": [
        'import { setTimeout } from "node:timers/promises";',
        "await setTimeout(1);",
        'console.log("tla: ok");',
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("tla: ok");
  });

  test("top-level await without any import/export is still module syntax", () => {
    // Node.js's own detection counts top-level await as module syntax; the file only
    // parses as a module, so it must flip rather than hit the CommonJS machinery, which
    // rejects it (`await is only valid in async functions ...`).
    const root = fixture({
      "package.json": COMMONJS,
      "entry.ts": [
        "await new Promise(resolve => setTimeout(resolve, 1));",
        'console.log("tla-only: ok");',
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("tla-only: ok");
  });

  test("top-level `for await` is module syntax too", () => {
    // The unambiguous parse cannot resolve this one to a module on its own — the
    // module-mode retry is what catches it.
    const root = fixture({
      "package.json": COMMONJS,
      "entry.ts": [
        "for await (const value of [1, 2]) {",
        '  console.log("for-await:", value);',
        "}",
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("for-await: 2");
  });

  test("an imported top-level-await module without import/export runs", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "cjs/package.json": COMMONJS,
      "cjs/dep.ts": [
        "await new Promise(resolve => setTimeout(resolve, 1));",
        'globalThis.__tlaDep = "tla-dep-ok";',
      ].join("\n"),
      "entry.ts": [
        'await import("./cjs/dep.ts");',
        'console.log("tla-dep:", (globalThis as Record<string, any>).__tlaDep);',
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("tla-dep: tla-dep-ok");
  });

  test("a .js file with ESM syntax runs as an ES module", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "entry.js": [
        'import { readFileSync } from "node:fs";',
        'console.log("js format:", typeof require === "undefined" ? "module" : "commonjs");',
        'console.log("fs:", typeof readFileSync);',
      ].join("\n"),
    });
    const output = run(root, "./entry.js");
    expect(output).toContain("js format: module");
    expect(output).toContain("fs: function");
  });

  test("a file without module syntax still runs as CommonJS", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "entry.ts": [
        'console.log("format:", typeof require === "undefined" ? "module" : "commonjs");',
        'console.log("exports:", typeof module !== "undefined" ? typeof module.exports : "n/a");',
      ].join("\n"),
    });
    const output = run(root, "./entry.ts");
    expect(output).toContain("format: commonjs");
    expect(output).toContain("exports: object");
  });

  test("`export =` still compiles to module.exports", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "legacy.ts": "const x = 42;\nexport = x;\n",
      // No ESM syntax anywhere, so both files stay CommonJS end to end.
      "entry.ts": ['const x = require("./legacy.ts");', 'console.log("export=:", x);'].join("\n"),
      // `export =` is TypeScript's CommonJS construct, not ESM syntax: imported through
      // the ESM loader it must stay CommonJS and arrive through the default interop.
      "consumer.mts": ['import x from "./legacy.ts";', 'console.log("export= esm:", x);'].join(
        "\n",
      ),
    });
    expect(run(root, "./entry.ts")).toContain("export=: 42");
    expect(run(root, "./consumer.mts")).toContain("export= esm: 42");
  });

  test("an import with a query string is still recognised", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "dep.ts": 'export const dep = "query-ok";\n',
      "entry.ts": ['import { dep } from "./dep.ts?v=1";', 'console.log("query:", dep);'].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("query: query-ok");
  });

  test("a file whose only module syntax is import.meta runs as an ES module", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "entry.js": 'console.log("meta:", import.meta.url.startsWith("file:"));\n',
    });
    expect(run(root, "./entry.js")).toContain("meta: true");
  });

  test("a file whose only module syntax is a type-only import runs as an ES module", () => {
    // `import type` is erased, but the transform injects `export {}` so that the output
    // stays a module — the CommonJS path never could run such a file (it crashed with
    // ERR_REQUIRE_CYCLE_MODULE), so flipping to ESM is the only working behaviour. CJS
    // globals were never available to it either way.
    const root = fixture({
      "package.json": COMMONJS,
      "types.ts": "export type ExecPath = string;\n",
      "entry.ts": [
        'import type { ExecPath } from "./types";',
        "const p: ExecPath = process.execPath;",
        'console.log("type-only:", typeof require === "undefined", p.length > 0);',
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("type-only: true true");
  });

  test("`require()` completes an extensionless TypeScript specifier", () => {
    // `module.registerHooks()` routes `require()` through the resolve hook, where
    // `nextResolve` is Node.js' CommonJS resolver — and that resolver only completes
    // `./dep` to `./dep.ts`, or `./sub` to `./sub/index.ts`, for extensions present in
    // `Module._extensions`. The `pirates` hook is what puts them there, so dropping it
    // makes both requires below fail with MODULE_NOT_FOUND, which nothing else here
    // would catch.
    const root = fixture({
      "package.json": COMMONJS,
      // Type annotations, so the files cannot run at all unless they were transformed.
      "dep.ts": 'const value: string = "dep-ok";\nexports.dep = value;\n',
      "sub/index.ts": 'const value: string = "sub-ok";\nexports.sub = value;\n',
      "entry.ts": [
        'const { dep } = require("./dep");',
        'const { sub } = require("./sub");',
        'console.log("require:", dep, sub);',
      ].join("\n"),
    });
    expect(run(root, "./entry.ts")).toContain("require: dep-ok sub-ok");
  });

  test("a .cts file is CommonJS by contract and never flips", () => {
    const root = fixture({
      "package.json": COMMONJS,
      // A helper-requiring transform (lowered class field) on top of ESM syntax: the
      // extension says CommonJS, so helpers are emitted as `require()` and the file must
      // not be reported as an ES module — that combination is exactly the broken state.
      "entry.cts": [
        "class Holder {",
        "  field = 1;",
        "}",
        "export const out = new Holder().field;",
        'console.log("cts:", out);',
      ].join("\n"),
    });
    const result = spawnSync(
      process.execPath,
      ["--import", "@oxc-node/core/register", "./entry.cts"],
      { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: undefined } },
    );
    const output = `${result.stdout}${result.stderr}`;
    // `.cts` has no ESM downlevel here, so the ESM syntax itself is what may fail — but
    // the half-flipped `require()`-in-an-ES-module state must never appear.
    expect(output).not.toContain("require is not defined in ES module scope");
  });
});
