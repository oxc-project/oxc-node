import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import { supportsRegisterHooks } from "../../core/hooks.mjs";

/**
 * These specs pin the behaviour the loader must keep no matter which implementation
 * `register.mjs` picks: the synchronous `module.registerHooks()` hooks or the asynchronous
 * `module.register()` fallback. Each one runs a child process against a fixture tree
 * written to a temporary directory, because several of them need a `node_modules`
 * directory or a directory name that would be awkward to commit.
 */

const REGISTER = fileURLToPath(new URL("../../core/register.mjs", import.meta.url));
const CORE = dirname(REGISTER);
const USES_REGISTER_HOOKS = supportsRegisterHooks(process.versions.node);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** `junction` is the only link type Windows allows without elevated privileges. */
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

/** Write `files` (path relative to the root -> contents) into a fresh temp directory. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-loader-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  // Transformed output can import `@oxc-node/core/helpers/…`, so the fixture needs the
  // package installed just like a real project does.
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  link(CORE, join(root, "node_modules", "@oxc-node", "core"));
  return root;
}

function spawn(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, ...extraEnv },
    // `spawnSync` blocks the event loop, so Vitest's own timeout cannot interrupt it. A
    // regression that keeps the loader thread — and therefore the child — alive would
    // otherwise hang the run until the CI job times out.
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.signal, `child was killed with ${result.signal}, it probably did not exit`).toBe(
    null,
  );
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

/** Run `node --import @oxc-node/core/register …` and assert it succeeded. */
function runOk(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string {
  const { output, status } = spawn(cwd, ["--import", REGISTER, ...args], extraEnv);
  expect(status, output).toBe(0);
  return output;
}

/**
 * The value the fixture printed as `<name>: <value>`. Asserting on a parsed value rather
 * than on the whole output keeps temporary paths and `OXC_LOG`/`DEBUG` noise — both of
 * which CI enables — from deciding whether a test passes.
 */
function reported(output: string, name: string): string {
  const match = new RegExp(`^${name}: (.*)$`, "m").exec(output);
  expect(match, `expected the fixture to report "${name}:" in:\n${output}`).toBeTruthy();
  return match![1]!.trim();
}

const MODULE_PACKAGE = JSON.stringify({ name: "fx", private: true, type: "module" });
const COMMONJS_PACKAGE = JSON.stringify({ name: "fx", private: true, type: "commonjs" });

describe("supportsRegisterHooks", () => {
  // `module.registerHooks()` exists from v22.15.0 / v23.5.0, but until v24.18.0 / v26.2.0
  // Node.js resolved a `require()` made from a translator-loaded CommonJS module with the
  // `import` conditions, which a loader cannot tell apart from a real `import`.
  test.each([
    ["20.19.0", false],
    ["21.7.3", false],
    ["22.15.0", false],
    ["22.19.0", false],
    ["22.22.2", false],
    ["22.22.3", true],
    ["22.23.2", true],
    ["23.11.0", false],
    ["24.0.0", false],
    ["24.7.0", false],
    ["24.8.0", true],
    ["24.20.0", true],
    ["25.9.0", true],
    ["26.0.0", true],
    ["26.8.1", true],
    ["27.0.0", true],
  ])("%s -> %s", (version, expected) => {
    expect(supportsRegisterHooks(version)).toBe(expected);
    // `process.version` style input has to work too.
    expect(supportsRegisterHooks(`v${version}`)).toBe(expected);
  });

  test("rejects anything unparseable", () => {
    for (const version of [undefined, "", "24", "not-a-version"]) {
      expect(supportsRegisterHooks(version)).toBe(false);
    }
  });
});

describe("CommonJS require()", () => {
  const REQUIRE_FIXTURE = {
    "package.json": COMMONJS_PACKAGE,
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "CommonJS", target: "ES2022" } }),
    "helper.ts": "export const answer: number = 42;\n",
    // `foo.json` and `foo.ts` both satisfy `require("./foo")`; Node.js' extension order
    // must keep winning, as it did when `require()` never reached the loader at all.
    "foo.json": JSON.stringify({ which: "json" }),
    "foo.ts": 'export const which = "ts";\n',
    "plain.tsx": "export const value = 2;\n",
    "plain.jsx": "export const value = 4;\n",
    "plain.es": "export const value = 5;\n",
    "plain.es6": "export const value = 6;\n",
    "entry.cjs": [
      'const assert = require("node:assert/strict");',
      'assert.equal(require("./helper").answer, 42);',
      'assert.equal(require("./foo").which, "json");',
      'for (const [ext, value] of [["tsx", 2], ["jsx", 4], ["es", 5], ["es6", 6]]) {',
      '  assert.equal(require("./plain." + ext).value, value, ext);',
      "}",
      'console.log("ok");',
    ].join("\n"),
  };

  test("resolves and transpiles every extension oxc-node owns", () => {
    expect(runOk(fixture(REQUIRE_FIXTURE), ["./entry.cjs"])).toContain("ok");
  });

  // The route that differs most between Node.js versions: `require()` of a TypeScript file
  // from a CommonJS module that Node.js itself loaded through the ESM CommonJS translator.
  // Before v24.18.0 / v26.2.0 that `require()` was resolved with the `import` conditions,
  // which is what `supportsRegisterHooks` gates on. `enum` also proves the file went
  // through oxc-node rather than Node.js' own type stripping, which rejects it.
  test("require() of a TypeScript file with syntax only oxc-node can lower", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", target: "ES2022" } }),
      "dep/package.json": COMMONJS_PACKAGE,
      "dep/mod.ts": ["export enum E {", "  A = 1,", "}", "export const v: number = E.A;"].join(
        "\n",
      ),
      "entry.cjs": [
        'const assert = require("node:assert/strict");',
        'assert.equal(require("./dep/mod.ts").v, 1);',
        'console.log("ok");',
      ].join("\n"),
      // …and the same file reached through an `import` instead.
      "entry.mts": [
        'import assert from "node:assert/strict";',
        'import { v } from "./dep/mod.ts";',
        "assert.equal(v, 1);",
        'console.log("ok");',
      ].join("\n"),
    });
    expect(runOk(root, ["./entry.cjs"])).toContain("ok");
    expect(runOk(root, ["./entry.mts"])).toContain("ok");
  });

  test("a .ts stack trace in a commonjs package points at the original source", () => {
    const root = fixture({
      "package.json": COMMONJS_PACKAGE,
      // `new Error(message)` is on line 3, column 9.
      "throws.ts": [
        "export function boom(): never {",
        '  const message: string = "boom";',
        "  throw new Error(message);",
        "}",
      ].join("\n"),
      "entry.cjs": [
        'const { boom } = require("./throws");',
        "try {",
        "  boom();",
        "} catch (error) {",
        '  const frame = error.stack.split("\\n").find((line) => line.includes("throws.ts"));',
        "  console.log(frame.trim());",
        "}",
      ].join("\n"),
    });
    expect(runOk(root, ["./entry.cjs"])).toMatch(/throws\.ts:3:9/);
  });

  // The `module.register()` fallback cannot serve `node -r`: `require()`ing the entry point
  // needs a synchronous `resolveSync()`, which the asynchronous loader only grew in later
  // releases. With `module.registerHooks()` it always works, which is what is pinned here.
  test.skipIf(!USES_REGISTER_HOOKS)("works through `node -r`", () => {
    const root = fixture(REQUIRE_FIXTURE);
    const { output, status } = spawn(root, ["-r", REGISTER, "./entry.cjs"]);
    expect(status, output).toBe(0);
    expect(output).toContain("ok");
  });

  test("keeps Node.js' named-export detection, including transitive re-exports", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "node_modules/cjs-pkg/package.json": JSON.stringify({
        name: "cjs-pkg",
        version: "1.0.0",
        main: "./index.js",
      }),
      // The shape bundlers emit and `cjs-module-lexer` follows across files.
      "node_modules/cjs-pkg/index.js": [
        "var __export = (m) => { for (var k in m) exports[k] = m[k]; };",
        '__export(require("./src"));',
      ].join("\n"),
      "node_modules/cjs-pkg/src/index.js": 'exports.foo = "foo";\n',
      "entry.ts": [
        'import assert from "node:assert/strict";',
        'import { foo } from "cjs-pkg";',
        'assert.equal(foo, "foo");',
        'console.log("ok");',
      ].join("\n"),
    });
    expect(runOk(root, ["./entry.ts"])).toContain("ok");
  });

  test("picks the `require` branch of an exports map, whichever conditions came first", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", module: "ESNext", paths: { "@seed": ["./seed.ts"] } },
      }),
      "seed.ts": 'export const seed = "seed";\n',
      "dual-pkg/package.json": JSON.stringify({
        name: "dual",
        version: "1.0.0",
        exports: { ".": { import: "./esm.mts", require: "./cjs.cts" } },
      }),
      "dual-pkg/esm.mts": 'export const branch = "import";\n',
      "dual-pkg/cjs.cts": 'export const branch = "require";\n',
      // Resolve something only oxc-node can resolve first, so the resolver is created with
      // the `import` conditions, and only then `require()` the dual package.
      "entry.ts": [
        'import assert from "node:assert/strict";',
        'import { createRequire } from "node:module";',
        'import { seed } from "@seed";',
        'assert.equal(seed, "seed");',
        'assert.equal(createRequire(import.meta.url)("dual").branch, "require");',
        'assert.equal((await import("dual")).branch, "import");',
        'console.log("ok");',
      ].join("\n"),
    });
    // `pirates` ignores node_modules, so link the package in from outside it — a real
    // node_modules package would hit Node.js' "type stripping is disabled in node_modules"
    // on both loaders.
    link(join(root, "dual-pkg"), join(root, "node_modules", "dual"));
    expect(runOk(root, ["./entry.ts"])).toContain("ok");
  });
});

describe("JSON modules", () => {
  // oxc-node synthesises one named export per key so that a dependency doing a bare
  // `import data from "./data.json"` keeps working without an import attribute — a caller
  // cannot add one to somebody else's source.
  const jsonFixture = () =>
    fixture({
      "package.json": MODULE_PACKAGE,
      "data.json": JSON.stringify({ name: "fx-json", version: "9.9.9" }),
      "default-import.ts": [
        'import data from "./data.json";',
        'console.log("version:", data.version);',
      ].join("\n"),
      "named-import.ts": [
        'import { version } from "./data.json";',
        'console.log("version:", version);',
      ].join("\n"),
      "dynamic-import.ts": [
        'const data = await import("./data.json");',
        'console.log("version:", data.default.version);',
      ].join("\n"),
      "with-attribute.ts": [
        'import data from "./data.json" with { type: "json" };',
        'console.log("version:", data.version);',
      ].join("\n"),
    });

  test.each(["default-import", "named-import", "dynamic-import", "with-attribute"])(
    "%s",
    (name) => {
      expect(reported(runOk(jsonFixture(), [`./${name}.ts`]), "version")).toBe("9.9.9");
    },
  );

  // An array or a scalar has no keys to turn into named exports, but the format still has to
  // match the one the resolve hook reported, or Node.js hands the generated source to
  // `Module._extensions[".json"]` and `JSON.parse` chokes on the JavaScript.
  test.each([
    ["an array", '["one","two"]', "2"],
    ["a number", "42", "42"],
    ["a string", '"text"', "text"],
  ])("%s still has a default export", (_name, json, expected) => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "data.json": json,
      "entry.ts": [
        'import data from "./data.json";',
        'console.log("value:", Array.isArray(data) ? data.length : data);',
      ].join("\n"),
    });
    expect(reported(runOk(root, ["./entry.ts"]), "value")).toBe(expected);
  });
});

describe("resolution", () => {
  test("tsconfig `paths` overrides a real node_modules package of the same name", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          paths: { shadowed: ["./src/shadowed.ts"] },
        },
      }),
      "src/shadowed.ts": 'export const who = "tsconfig-paths";\n',
      "node_modules/shadowed/package.json": JSON.stringify({
        name: "shadowed",
        version: "1.0.0",
        main: "./index.js",
      }),
      "node_modules/shadowed/index.js": 'exports.who = "node_modules";\n',
      "entry.ts": 'import { who } from "shadowed";\nconsole.log("who:", who);\n',
    });
    expect(runOk(root, ["./entry.ts"])).toContain("who: tsconfig-paths");
  });

  test("resolved URLs are percent-encoded, so a path with a space is one module", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "sp ace/m.ts": "export const url: string = import.meta.url;\nexport const id = {};\n",
      "entry.ts": [
        'import assert from "node:assert/strict";',
        'import { id, url } from "./sp ace/m.ts";',
        // The raw and the percent-encoded specifier must be the same module.
        'const encoded = await import("./sp%20ace/m.ts");',
        'assert.ok(!url.includes(" "), `resolved URL is not encoded: ${url}`);',
        "assert.equal(id, encoded.id);",
        'console.log("ok");',
      ].join("\n"),
    });
    expect(runOk(root, ["./entry.ts"])).toContain("ok");
  });

  test("a relative import from inside a directory with a space resolves", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "sp ace/sibling.ts": 'export const sibling = "sibling";\n',
      // Extensionless, so only oxc-node's resolver can answer it.
      "sp ace/inner.ts": 'export { sibling as inner } from "./sibling";\n',
      "entry.ts": 'import { inner } from "./sp ace/inner.ts";\nconsole.log("inner:", inner);\n',
    });
    expect(runOk(root, ["./entry.ts"])).toContain("inner: sibling");
  });

  test("a `?query` is not mistaken for a file extension", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "w.cjs": 'module.exports = { tag: "cjs" };\n',
      "entry.ts": [
        'const m = await import("./w.cjs?cache=.ts");',
        'console.log("tag:", m.default.tag);',
      ].join("\n"),
    });
    expect(reported(runOk(root, ["./entry.ts"]), "tag")).toBe("cjs");
  });

  // The extension has to be read from the URL's path: `Path::extension()` on the whole URL
  // reports `json?v=1`, which sent the JSON straight to the JavaScript parser.
  test.each(["?v=1", "#fragment"])("a JSON module keeps working with %s", (suffix) => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "data.json": JSON.stringify({ version: "1.2.3" }),
      "entry.ts": [
        `const data = await import("./data.json${suffix}");`,
        'console.log("version:", data.default.version);',
      ].join("\n"),
    });
    expect(reported(runOk(root, ["./entry.ts"]), "version")).toBe("1.2.3");
  });

  // `%` is the escape character, so a path that really contains one has to be escaped as
  // `%25` or Node.js decodes the URL back into a different path — or rejects it outright.
  test("a path containing a literal % resolves", () => {
    const root = fixture({
      "package.json": MODULE_PACKAGE,
      "100%.ts": 'export const value = "percent";\n',
      "entry.ts": ['import { value } from "./100%.ts";', 'console.log("value:", value);'].join(
        "\n",
      ),
    });
    expect(reported(runOk(root, ["./entry.ts"]), "value")).toBe("percent");
  });
});

describe("transforms", () => {
  // Oxc does not lower ES modules to CommonJS, so a module Node.js classified as CommonJS
  // can come out of the transform as an ES module — a `.ts` file in a `"type": "commonjs"`
  // package, a `.cts` file, a `.es6` file (which has no module type at all), or any file
  // that needed a transform helper. The loader reports the format that matches the code it
  // hands back, so those modules load and keep their named exports.
  //
  // Only the synchronous hooks can do this: Node.js hands a CommonJS-classified module
  // straight to the CommonJS loader without ever asking the asynchronous
  // `module.register()` loader, which is why these imports fail on the fallback.
  test.skipIf(!USES_REGISTER_HOOKS)(
    "a CommonJS-classified module whose output is an ES module keeps its exports",
    () => {
      const root = fixture({
        "package.json": MODULE_PACKAGE,
        "legacy.es6": 'export const value = "es6";\n',
        "dep/package.json": COMMONJS_PACKAGE,
        "dep/mod.ts": 'export const value: string = "cjs-scoped-ts";\n',
        "entry.ts": [
          'import assert from "node:assert/strict";',
          'import { value as legacy } from "./legacy.es6";',
          'import { value as scoped } from "./dep/mod.ts";',
          'assert.equal(legacy, "es6");',
          'assert.equal(scoped, "cjs-scoped-ts");',
          'console.log("ok");',
        ].join("\n"),
      });
      expect(runOk(root, ["./entry.ts"])).toContain("ok");
    },
  );

  // A plain `.js` file is oxc-node's too. Whether a public class field is initialised with
  // `[[Set]]` or `[[Define]]` semantics is observable, and `useDefineForClassFields`
  // selects between them — so running the same file under both settings and getting
  // different answers proves the `.js` file went through oxc-node and that the tsconfig
  // reached it. Which setting maps to which semantics is deliberately not asserted.
  const CLASS_FIELDS_MODULE = [
    "class Base {",
    "  set x(value) {",
    "    this.setterCalled = true;",
    "  }",
    "}",
    "class Derived extends Base {",
    "  x = 1;",
    "}",
    "export const setterCalled = new Derived().setterCalled === true;",
  ].join("\n");

  function classFieldsFixture(
    useDefineForClassFields: boolean,
    extra: Record<string, string> = {},
  ): string {
    return fixture({
      "package.json": MODULE_PACKAGE,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022", useDefineForClassFields },
      }),
      "mod.js": CLASS_FIELDS_MODULE,
      "entry.ts": [
        'import { setterCalled } from "./mod.js";',
        'console.log("setterCalled:", setterCalled);',
      ].join("\n"),
      ...extra,
    });
  }

  test("plain .js files are still transformed with the project tsconfig", () => {
    const withDefine = reported(runOk(classFieldsFixture(true), ["./entry.ts"]), "setterCalled");
    const withoutDefine = reported(
      runOk(classFieldsFixture(false), ["./entry.ts"]),
      "setterCalled",
    );
    // One of the two is the native `[[Define]]` behaviour and the other is oxc-node's
    // `[[Set]]` lowering; which is which is not this test's business, only that the tsconfig
    // reached the `.js` file at all.
    expect([withDefine, withoutDefine].sort()).toEqual(["false", "true"]);
  });

  test("OXC_TRANSFORM_ALL still reaches .js files inside node_modules", () => {
    const dependency = {
      "node_modules/dep/package.json": JSON.stringify({
        name: "dep",
        version: "1.0.0",
        type: "module",
        main: "./index.js",
      }),
      "node_modules/dep/index.js": CLASS_FIELDS_MODULE,
      "entry.ts": [
        'import { setterCalled } from "dep";',
        'console.log("setterCalled:", setterCalled);',
      ].join("\n"),
    };
    const transformAll = reported(
      runOk(classFieldsFixture(true, dependency), ["./entry.ts"], { OXC_TRANSFORM_ALL: "1" }),
      "setterCalled",
    );
    const untouched = reported(
      runOk(classFieldsFixture(true, dependency), ["./entry.ts"], { OXC_TRANSFORM_ALL: "" }),
      "setterCalled",
    );
    // Untransformed is the native `[[Define]]` behaviour, so the setter never runs.
    expect(untouched).toBe("false");
    expect(transformAll).toBe("true");
  });

  test("a CommonJS .cts stack trace points at the original source", () => {
    const root = fixture({
      "package.json": COMMONJS_PACKAGE,
      // `new Error(message)` is on line 3, column 9.
      "throws.cts": [
        "export function boom(): never {",
        '  const message: string = "boom";',
        "  throw new Error(message);",
        "}",
      ].join("\n"),
      "entry.cjs": [
        'const { boom } = require("./throws.cts");',
        "try {",
        "  boom();",
        "} catch (error) {",
        '  const frame = error.stack.split("\\n").find((line) => line.includes("throws.cts"));',
        "  console.log(frame.trim());",
        "}",
      ].join("\n"),
    });
    expect(runOk(root, ["./entry.cjs"])).toMatch(/throws\.cts:3:9/);
  });
});

describe("hook chain", () => {
  const HOOK_CHAIN = {
    "package.json": MODULE_PACKAGE,
    "dep.ts": 'export const dep = "dep";\n',
    "entry.ts": 'import { dep } from "./dep.ts";\nconsole.log("dep:", dep);\n',
    "observer.mjs": [
      'import { registerHooks } from "node:module";',
      "const seen = [];",
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      "    seen.push(specifier);",
      "    return nextResolve(specifier, context);",
      "  },",
      "});",
      'process.on("exit", () => {',
      '  const dep = seen.filter((specifier) => specifier.includes("dep"));',
      '  const observed = dep.length === 1 && dep[0].startsWith("file:") ? "url" : dep.join(",");',
      '  console.log("observed:", observed);',
      "});",
    ].join("\n"),
  };

  test("a hook registered after oxc-node sees the original specifier", () => {
    const output = runOk(fixture(HOOK_CHAIN), ["--import", "./observer.mjs", "./entry.ts"]);
    expect(output).toContain("dep: dep");
    expect(output).toContain("observed: ./dep.ts");
  });

  test("a hook registered before oxc-node also sees the original specifier", () => {
    // `module.registerHooks()` has a single chain and runs the most recently registered hook
    // first, so a hook registered *before* oxc-node runs after it. oxc-node still asks the
    // rest of the chain about the specifier as written, the way it looked when oxc-node's
    // hooks ran on a separate loader thread.
    const root = fixture(HOOK_CHAIN);
    const { output, status } = spawn(root, [
      "--import",
      "./observer.mjs",
      "--import",
      REGISTER,
      "./entry.ts",
    ]);
    expect(status, output).toBe(0);
    expect(output).toContain("dep: dep");
    expect(output).toContain("observed: ./dep.ts");
  });

  // The remaining difference from the `module.register()` loader, recorded rather than
  // hidden. There, oxc-node's hooks ran on a separate loader thread after every in-thread
  // hook, so short circuiting one replaced the module whichever order it was registered in.
  // The synchronous hooks are a single chain in which oxc-node resolves first and its URL
  // wins, so a hook that redirects a specifier has to be registered after oxc-node.
  test("a redirect wins when the hook is registered after oxc-node", () => {
    const root = fixture({
      ...HOOK_CHAIN,
      "mock.ts": 'export const dep = "mocked";\n',
      "redirect.mjs": [
        'import { registerHooks } from "node:module";',
        "registerHooks({",
        "  resolve(specifier, context, nextResolve) {",
        '    if (specifier === "./dep.ts" || specifier.endsWith("/dep.ts")) {',
        '      return { url: new URL("./mock.ts", import.meta.url).href, shortCircuit: true };',
        "    }",
        "    return nextResolve(specifier, context);",
        "  },",
        "});",
      ].join("\n"),
    });
    const after = spawn(root, ["--import", REGISTER, "--import", "./redirect.mjs", "./entry.ts"]);
    expect(after.status, after.output).toBe(0);
    expect(after.output).toContain("dep: mocked");

    const before = spawn(root, ["--import", "./redirect.mjs", "--import", REGISTER, "./entry.ts"]);
    expect(before.status, before.output).toBe(0);
    // Registered first means it runs last, so oxc-node's resolution wins — unlike under the
    // `module.register()` loader, where the in-thread hook always ran first.
    expect(before.output).toContain(USES_REGISTER_HOOKS ? "dep: dep" : "dep: mocked");
  });
});

test("the deprecated module.register() is not used when registerHooks() can be", () => {
  const root = fixture({ "package.json": MODULE_PACKAGE, "entry.ts": 'console.log("ok");\n' });
  const output = runOk(root, ["./entry.ts"]);
  expect(output).toContain("ok");
  if (USES_REGISTER_HOOKS) {
    // DEP0205 is emitted from v26.0.0. Versions that cannot use `module.registerHooks()`
    // (see `supportsRegisterHooks`) still emit it, so only assert where it is avoidable.
    expect(output).not.toContain("DEP0205");
  }
});
