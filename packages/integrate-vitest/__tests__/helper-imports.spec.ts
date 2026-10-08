import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * When a transform needs a runtime helper, oxc injects an import of it. Whether that is an
 * `import` declaration or a `require()` call is decided by the module kind of the source,
 * and for `.js`, `.jsx`, `.ts` and `.tsx` oxc infers that from the presence of
 * `import`/`export` syntax — so a file that happens to have none looks like a script.
 *
 * Node.js decides from the nearest `package.json` instead, so such a file inside a
 * `"type": "module"` package is executed as an ES module and the injected `require()` fails
 * with `ReferenceError: require is not defined in ES module scope`. The loader knows the
 * format Node.js reported and passes it down, so these specs cover both module kinds with
 * and without module syntax.
 */

// `--import` takes a module specifier, so hand it the URL itself: an absolute path only
// works on POSIX — on Windows the drive letter is parsed as a URL scheme (`c:`) and
// Node.js exits with ERR_UNSUPPORTED_ESM_URL_SCHEME before the hooks are registered.
const REGISTER_URL = new URL("../../core/register.mjs", import.meta.url);
const CORE = dirname(fileURLToPath(REGISTER_URL));

/**
 * A transform that needs a helper: a class field installed with `[[Define]]` semantics is
 * lowered to `@oxc-node/core/helpers/defineProperty`.
 *
 * `target: ES2022` with `useDefineForClassFields` left unset is deliberate — that is
 * `[[Define]]` both by TypeScript's own default for this target and under the mapping
 * oxc-node used before #742, so this fixture exercises a helper either way.
 */
const NEEDS_HELPER = [
  "class Holder {",
  "  field = 1;",
  "}",
  'const report = () => console.log("field:", new Holder().field);',
];

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>, { linkCore = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-helpers-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  if (linkCore) {
    mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
    symlinkSync(
      CORE,
      join(root, "node_modules", "@oxc-node", "core"),
      // `junction` is the only link type Windows allows without elevated privileges.
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  return root;
}

function runRaw(root: string, entry: string, imports: string[] = [REGISTER_URL.href]) {
  return spawnSync(process.execPath, [...imports.flatMap((i) => ["--import", i]), entry], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      // Vitest exports the workspace's node_modules through NODE_PATH, which would
      // make project-scoped resolution find the repo's own @oxc-node/core from a
      // temp project.
      NODE_PATH: undefined,
      // An explicit tsconfig from the environment wins over every fixture's own
      // tsconfig.json, so inheriting one would silently rewrite the matrix — or
      // neutralise it entirely if it also turns helper injection off.
      // `OXC_TRANSFORM_ALL` is left alone: CI sets it on purpose.
      TS_NODE_PROJECT: undefined,
      OXC_TSCONFIG_PATH: undefined,
    },
    timeout: 30_000,
  });
}

function run(root: string, entry: string, imports?: string[]): string {
  const result = runRaw(root, entry, imports);
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

// For a `.ts` file the loader asks the file's own tsconfig for the module kind before it
// falls back to the nearest package.json `type`, so the tsconfig has to agree with the
// package for a `commonjs` row to actually load — and execute — as CommonJS.
const tsconfig = (module: string) =>
  JSON.stringify({ compilerOptions: { module, target: "ES2022" } });

describe("injected runtime helpers", () => {
  test.each([
    // A `"type": "module"` package: every extension below is an ES module to Node.js, but
    // only `.mts` says so through its extension.
    ["module", "entry.ts", "no module syntax"],
    ["module", "entry.mts", "no module syntax"],
    // `.jsx` arrives with no module type at all — oxc_resolver only consults the
    // package `type` for `.js` and `.ts` — so this row needs the package.json
    // fallback that fixed #797. A `.tsx` row would not exercise it: the file's
    // own tsconfig claims it and its `module` value answers first.
    ["module", "entry.jsx", "no module syntax"],
    ["module", "entry.ts", "with an export"],
    ["commonjs", "entry.ts", "no module syntax"],
    ["commonjs", "entry.cts", "no module syntax"],
  ])("a %s package loading %s (%s)", (type, entry, shape) => {
    const body = [...NEEDS_HELPER];
    if (shape === "with an export") {
      body.push("export const exported = true;");
    }
    body.push("report();");
    // Prove the file really executed as the module kind the row claims: `require`
    // only exists in a CommonJS scope, and `typeof` does not throw on the missing
    // binding in an ES module.
    body.push('console.log("format:", typeof require === "undefined" ? "module" : "commonjs");');
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type }),
      "tsconfig.json": tsconfig(type === "module" ? "ESNext" : "CommonJS"),
      [entry]: body.join("\n"),
    });
    const output = run(root, `./${entry}`);
    expect(output).toContain("field: 1");
    expect(output).toContain(`format: ${type}`);
  });

  test("an imported module without module syntax also gets a usable helper", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "tsconfig.json": tsconfig("ESNext"),
      // No `import`/`export`, so oxc would infer a script and inject `require()`.
      "dep.ts": [
        ...NEEDS_HELPER,
        "globalThis.__report = report;",
        'globalThis.__format = typeof require === "undefined" ? "module" : "commonjs";',
      ].join("\n"),
      "entry.ts": [
        'import "./dep.ts";',
        "(globalThis as Record<string, any>).__report();",
        'console.log("format:", (globalThis as Record<string, any>).__format);',
      ].join("\n"),
    });
    const output = run(root, "./entry.ts");
    expect(output).toContain("field: 1");
    expect(output).toContain("format: module");
  });
});

// https://github.com/oxc-project/oxc-node/issues/794 — with no `@oxc-node/core`
// reachable from the transformed file (a global `oxnode`, or `node --import` on a
// script outside a project), the emitted `require("@oxc-node/core/helpers/*")`
// and `import` specifiers must resolve against the loader's own copy instead.
// `linkCore: false` plus invoking register.mjs by absolute file URL simulates the
// global install: register.mjs is self-contained (node: builtins, `pirates`, and
// `./index.js`), so it needs nothing from the user's node_modules.
describe("global install (no @oxc-node/core in the project)", () => {
  test("a bare directory: issue #794 repro", () => {
    const root = fixture(
      {
        "counter.ts": [
          "class Counter {",
          "  count = 1;",
          "}",
          'console.log("count:", new Counter().count);',
        ].join("\n"),
      },
      { linkCore: false },
    );
    const output = run(root, "./counter.ts");
    expect(output).toContain("count: 1");
  });

  test("ESM helper imports resolve from the loader's copy", () => {
    const root = fixture(
      {
        "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
        "tsconfig.json": tsconfig("ESNext"),
        // Module syntax, so oxc emits an `import` for the helper and Node.js' ESM
        // resolver — the loader's `resolve` hook — sees the specifier.
        "dep.ts": [...NEEDS_HELPER, "globalThis.__report = report;", "export {};"].join("\n"),
        "entry.mts": [
          'import "./dep.ts";',
          "(globalThis as Record<string, any>).__report();",
          'console.log("format:", "module");',
        ].join("\n"),
      },
      { linkCore: false },
    );
    const output = run(root, "./entry.mts");
    expect(output).toContain("field: 1");
    expect(output).toContain("format: module");
  });

  test("unrelated specifiers still resolve — and still fail — from the project", () => {
    const root = fixture(
      {
        "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
        "tsconfig.json": tsconfig("ESNext"),
        "node_modules/fixture-pkg/package.json": JSON.stringify({
          name: "fixture-pkg",
          version: "0.0.0",
          type: "module",
          exports: { ".": "./index.js" },
        }),
        "node_modules/fixture-pkg/index.js": 'export const msg = "fixture-pkg ok";',
        "entry.mts": ['import { msg } from "fixture-pkg";', "console.log(msg);"].join("\n"),
        "missing.mts": 'import "not-installed-pkg";',
      },
      { linkCore: false },
    );
    expect(run(root, "./entry.mts")).toContain("fixture-pkg ok");

    const result = runRaw(root, "./missing.mts");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("ERR_MODULE_NOT_FOUND");
  });

  test("a poisoned project copy cannot shadow the loader's helpers", () => {
    const root = fixture(
      {
        // The project-visible `@oxc-node/core` only exports ".", so it has no
        // helpers subtree — resolution that consulted it would throw
        // ERR_PACKAGE_PATH_NOT_EXPORTED.
        "node_modules/@oxc-node/core/package.json": JSON.stringify({
          name: "@oxc-node/core",
          version: "0.0.0",
          exports: { ".": "./index.js" },
        }),
        "node_modules/@oxc-node/core/index.js": 'module.exports = { marker: "stub" };',
        "entry.ts": [
          ...NEEDS_HELPER,
          "report();",
          // Only `helpers/*` specifiers are redirected; the package root still
          // resolves from the project's own node_modules.
          'console.log("marker:", require("@oxc-node/core").marker);',
        ].join("\n"),
      },
      { linkCore: false },
    );
    const output = run(root, "./entry.ts");
    expect(output).toContain("field: 1");
    expect(output).toContain("marker: stub");
  });
});

// Two copies of the loader registered in one process — `NODE_OPTIONS` preloading one
// while a global `oxnode` adds another — used to resolve every helper from the
// *first*-registered copy: its `resolve` hook re-claimed the specifier inside
// `nextResolve`, and its `Module._resolveFilename` wrapper re-claimed it inside
// `requireHelper.resolve`. Each copy now tags the helper specifiers it emits
// (`@oxc-node/core@<tag>/helpers/x`), so a helper resolves against the copy whose
// transformer emitted it; each copy marks its own `defineProperty` here so the
// executed code reports which copy supplied it.
//
// Which copy emits is the first-registered one on both paths: pirates' `addHook`
// chains by wrapping `mod._compile`, and `module.register`'s load hooks wrap each
// other — in both cases the first copy transforms the raw source and the second
// sees already-lowered output with nothing left to emit.
//
// A second copy only works where the binding is a file inside this package: the WASI
// job's `oxc-node.wasi.cjs` needs `@oxc-node/core-wasm32-wasi` and `@napi-rs/wasm-runtime`
// from the workspace store, which a bare copy of this directory does not have.
const hasNativeBinding = readdirSync(CORE).some((name) => name.endsWith(".node"));

// The tag a copy stamps into its helper specifiers is the hash of its own module URL,
// which Node.js realpaths — `/tmp` is `/private/tmp` on macOS — so the same function
// derives it here to write tagged specifiers into test files.
const moduleTag = (file: string) =>
  "c" +
  createHash("sha256")
    .update(pathToFileURL(realpathSync(file)).href)
    .digest("hex")
    .slice(0, 12);

describe.skipIf(!hasNativeBinding)("two registered copies of the loader", () => {
  // Copies must be real directories, not symlinks to one path: Node.js keys the module
  // registry on realpaths, so two links to the same core would be a single copy.
  function copyOfCore(root: string, name: string): string {
    const copy = join(root, name);
    // `dereference` matters: pnpm links this package's own deps (`pirates`, the
    // napi helpers) as relative symlinks, which would dangle at the new location.
    cpSync(CORE, copy, { recursive: true, dereference: true });
    for (const variant of ["src/helpers", "src/helpers/esm"]) {
      const helper = join(copy, variant, "defineProperty.js");
      writeFileSync(
        helper,
        `globalThis.__helperCopy = ${JSON.stringify(name)};\n${readFileSync(helper, "utf8")}`,
      );
    }
    return copy;
  }

  test("helpers resolve to the copy whose transformer emitted them", () => {
    const root = fixture(
      {
        "package.json": JSON.stringify({ name: "fx", private: true, type: "commonjs" }),
        "tsconfig.json": tsconfig("ESNext"),
      },
      { linkCore: false },
    );
    const copyA = copyOfCore(root, "copy-a");
    const copyB = copyOfCore(root, "copy-b");
    const imports = [
      pathToFileURL(join(copyA, "register.mjs")).href,
      pathToFileURL(join(copyB, "register.mjs")).href,
    ];

    // CommonJS specifiers carry the `register.mjs` tag. ESM ones carry the `esm.mjs`
    // tag under `module.register`, but on Node.js ≥26.2 `register.mjs` serves both
    // realms through `registerHooks`, so its tag is used there too.
    const tagA = moduleTag(join(copyA, "register.mjs"));
    const tagB = moduleTag(join(copyB, "register.mjs"));
    const [nodeMajor, nodeMinor] = process.versions.node.split(".", 2).map(Number);
    const syncHooks = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 2);
    const tagAEsm = moduleTag(join(copyA, syncHooks ? "register.mjs" : "esm.mjs"));
    const tagBEsm = moduleTag(join(copyB, syncHooks ? "register.mjs" : "esm.mjs"));

    writeFileSync(
      join(root, "entry.cts"),
      [
        ...NEEDS_HELPER,
        // The emitted require() came from the first-registered copy's transform.
        'console.log("emitted:", (globalThis as Record<string, any>).__helperCopy);',
        // A tagged specifier resolves through its owner's resolver.
        `console.log("tagA:", require.resolve("@oxc-node/core@${tagA}/helpers/defineProperty"));`,
        `console.log("tagB:", require.resolve("@oxc-node/core@${tagB}/helpers/defineProperty"));`,
        // Untagged specifiers — what older published copies emit — try every
        // registered resolver, newest first.
        'console.log("untagged:", require.resolve("@oxc-node/core/helpers/defineProperty"));',
        "report();",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "entry.mts"),
      [
        'import "./emitted.mts";',
        `import "@oxc-node/core@${tagAEsm}/helpers/defineProperty";`,
        'import "./report-a.mts";',
        `import "@oxc-node/core@${tagBEsm}/helpers/defineProperty";`,
        'import "./report-b.mts";',
        'import "@oxc-node/core/helpers/defineProperty";',
        'import "./report-u.mts";',
        ...NEEDS_HELPER,
        "report();",
        "export {};",
      ].join("\n"),
    );
    // The class goes in the imported file: an emitted helper import lands after the
    // importer's own import declarations, so asserting from a plain dep would race it.
    writeFileSync(
      join(root, "emitted.mts"),
      [
        ...NEEDS_HELPER,
        'console.log("emitted:", (globalThis as Record<string, any>).__helperCopy);',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "report-a.mts"),
      'console.log("tagA:", (globalThis as Record<string, any>).__helperCopy);',
    );
    writeFileSync(
      join(root, "report-b.mts"),
      'console.log("tagB:", (globalThis as Record<string, any>).__helperCopy);',
    );
    writeFileSync(
      join(root, "report-u.mts"),
      'console.log("untagged:", (globalThis as Record<string, any>).__helperCopy);',
    );

    const cjs = run(root, "./entry.cts", imports);
    expect(cjs).toContain("field: 1");
    expect(cjs).toContain("emitted: copy-a");
    const helperA = realpathSync(join(copyA, "src/helpers/defineProperty.js"));
    const helperB = realpathSync(join(copyB, "src/helpers/defineProperty.js"));
    expect(cjs).toContain(`tagA: ${helperA}`);
    expect(cjs).toContain(`tagB: ${helperB}`);
    expect(cjs).toContain(`untagged: ${helperB}`);

    const esm = run(root, "./entry.mts", imports);
    expect(esm).toContain("field: 1");
    expect(esm).toContain("emitted: copy-a");
    expect(esm).toContain("tagA: copy-a");
    expect(esm).toContain("tagB: copy-b");
    expect(esm).toContain("untagged: copy-b");
  });
});
