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
  });
  expect(result.error, result.error?.message).toBeFalsy();
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

/** Run `node --import @oxc-node/core/register …` and assert it succeeded. */
function runOk(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string {
  const { output, status } = spawn(cwd, ["--import", REGISTER, ...args], extraEnv);
  expect(status, output).toBe(0);
  return output;
}

const MODULE_PACKAGE = JSON.stringify({ name: "fx", private: true, type: "module" });
const COMMONJS_PACKAGE = JSON.stringify({ name: "fx", private: true, type: "commonjs" });

describe("supportsRegisterHooks", () => {
  // `module.registerHooks()` exists from v22.15.0 / v23.5.0, but until v24.18.0 / v26.2.0
  // Node.js resolved a `require()` made from a translator-loaded CommonJS module with the
  // `import` conditions, which a loader cannot tell apart from a real `import`.
  test.each([
    ["20.19.0", false],
    ["22.15.0", false],
    ["22.19.0", false],
    ["22.23.2", false],
    ["23.11.0", false],
    ["24.0.0", false],
    ["24.5.0", false],
    ["24.17.9", false],
    ["24.18.0", true],
    ["24.20.0", true],
    ["25.9.0", false],
    ["26.0.0", false],
    ["26.1.9", false],
    ["26.2.0", true],
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
      expect(runOk(jsonFixture(), [`./${name}.ts`])).toContain("version: 9.9.9");
    },
  );
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
    expect(runOk(root, ["./entry.ts"])).toContain("tag: cjs");
  });
});

describe("transforms", () => {
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
    const withDefine = runOk(classFieldsFixture(true), ["./entry.ts"]);
    const withoutDefine = runOk(classFieldsFixture(false), ["./entry.ts"]);
    expect(withDefine).toMatch(/setterCalled: (true|false)/);
    expect(withDefine).not.toEqual(withoutDefine);
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
    const transformAll = runOk(classFieldsFixture(true, dependency), ["./entry.ts"], {
      OXC_TRANSFORM_ALL: "1",
    });
    const untouched = runOk(classFieldsFixture(true, dependency), ["./entry.ts"], {
      OXC_TRANSFORM_ALL: "",
    });
    expect(transformAll).not.toEqual(untouched);
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

  test("a hook registered before oxc-node still observes every module", () => {
    // `module.registerHooks()` has a single chain and runs the most recently registered
    // hook first, so a hook registered *before* oxc-node now runs after it and is handed
    // the resolved URL instead of the original specifier. It still sees every module.
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
    expect(output).toContain(USES_REGISTER_HOOKS ? "observed: url" : "observed: ./dep.ts");
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
