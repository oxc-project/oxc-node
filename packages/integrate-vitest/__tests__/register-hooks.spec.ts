import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * `module.registerHooks()` runs the hooks in-thread and shows them requests that
 * `module.register()` never did, so two things have to hold that the asynchronous hooks
 * got for free:
 *
 * - its default load is synchronous and always reads the file, so a `commonjs` result
 *   arrives with its bytes attached — even for a `.node` addon or a latin-1 file, where
 *   the asynchronous default load returned no source and left the read to the CommonJS
 *   machinery. Bytes that are not UTF-8 are not source code to transform, so they are
 *   handed back the same way instead of failing to decode.
 * - `require()` reaches the hooks, and it is the absent `importAttributes` that tells
 *   such a request apart — the field the native hooks require anyway. The `require`
 *   export condition cannot: `--conditions` appends its values to *every* request, so it
 *   appears on imports too.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));
const COMMONJS = JSON.stringify({ name: "fx", private: true, type: "commonjs" });

// The loader's own addon is the one binary that is guaranteed to be loadable by the
// Node.js running these tests; a WASI build of the package has none.
const addon = readdirSync(CORE).find((name) => name.endsWith(".node"));
const ADDON_ENTRY = [
  'import addon from "./addon.node";',
  'console.log("addon:", typeof addon.transform);',
].join("\n");
const ADDON_DEP_ENTRY = [
  'import addon from "addon-dep";',
  'console.log("addon:", typeof addon.transform);',
].join("\n");
// `café` in latin-1: the trailing `0xe9` is not valid UTF-8, and Node.js decodes it to a
// single replacement character — a four character string either way.
const LATIN1_SOURCE = Uint8Array.from([
  ...Buffer.from('module.exports = "caf', "utf8"),
  0xe9,
  ...Buffer.from('";\n', "utf8"),
]);

const [nodeMajor, nodeMinor] = process.versions.node.split(".", 2).map(Number);
// `import` of a `.node` addon is on by default from v24.19.0 and v26.5.0; on the 22 line
// the flag exists (v22.20.0) but stays opt-in. 23 and 25 are end-of-life and not in the
// CI matrix, so they are not modelled.
const addonImportsByDefault =
  (nodeMajor === 24 && nodeMinor >= 19) || nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 5);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-hooks-"));
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

function spawn(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    // A bare specifier resolves through the symlinked node_modules on every platform,
    // Windows included — an absolute path would not parse as a URL.
    ["--import", "@oxc-node/core/register", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        OXC_LOG: undefined,
        TS_NODE_PROJECT: undefined,
        OXC_TSCONFIG_PATH: undefined,
        ...env,
      },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  return { status: result.status, output };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const { status, output } = spawn(root, args, env);
  expect(status, output).toBe(0);
  return output;
}

/** Runs a fixture that must fail, and must fail with Node.js' own error rather than one
 * blaming the load hook's return shape. */
function runFailing(root: string, args: string[], code: string, env: NodeJS.ProcessEnv = {}) {
  const { status, output } = spawn(root, args, env);
  expect(status, output).not.toBe(0);
  expect(output).toContain(code);
  expect(output).not.toContain("ERR_INVALID_RETURN_PROPERTY_VALUE");
  expect(output).not.toContain("Missing field");
}

describe("a local source that is not UTF-8", () => {
  test.skipIf(addon === undefined)("an imported `.node` addon still loads", () => {
    // `.node` resolves as `commonjs`, so the addon arrives at the load hook as a binary
    // blob. Transforming it is not possible and not needed: `process.dlopen` reads the
    // file itself once the CommonJS machinery takes over.
    const root = fixture({
      "package.json": COMMONJS,
      "addon.node": readFileSync(join(CORE, addon!)),
      "entry.mts": ADDON_ENTRY,
    });
    expect(run(root, ["./entry.mts"])).toContain("addon: function");
  });

  test.skipIf(addon === undefined)(
    "an imported `.node` addon still loads with --experimental-addon-modules",
    () => {
      // The flag decides the format Node.js reports for a `.node` file, not the one
      // oxc-node does: a local addon is still `commonjs` and still reaches `dlopen`
      // through the CommonJS machinery rather than Node.js' `addon` translator.
      const root = fixture({
        "package.json": COMMONJS,
        "addon.node": readFileSync(join(CORE, addon!)),
        "entry.mts": ADDON_ENTRY,
      });
      expect(run(root, ["--experimental-addon-modules", "./entry.mts"])).toContain(
        "addon: function",
      );
    },
  );

  test.skipIf(addon === undefined)("a `require()`d `.node` addon still loads", () => {
    // `require()` reaches the synchronous hooks and is handed straight back to Node.js;
    // `module.register()` never showed it to the hooks at all.
    const root = fixture({
      "package.json": COMMONJS,
      "addon.node": readFileSync(join(CORE, addon!)),
      "entry.cts": [
        'const addon = require("./addon.node");',
        'console.log("addon:", typeof addon.transform);',
      ].join("\n"),
    });
    expect(run(root, ["./entry.cts"])).toContain("addon: function");
  });

  test("an imported latin-1 CommonJS file still loads", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "legacy.js": LATIN1_SOURCE,
      "entry.mts": [
        'import legacy from "./legacy.js";',
        'console.log("latin1:", legacy.length);',
      ].join("\n"),
    });
    expect(run(root, ["./entry.mts"])).toContain("latin1: 4");
  });
});

// A dependency is resolved by oxc-node but its format is left to Node.js, so these are
// the cases where Node.js' own formats — `addon`, `commonjs-typescript`,
// `module-typescript`, or none at all — reach the load hook. The CI matrix runs the suite
// under both `OXC_TRANSFORM_ALL` values; for a dependency that setting decides whether
// `transform_output` transforms it or hands it back untouched, so these run under both
// regardless of what the job set.
describe.each(["false", "true"])("a dependency, OXC_TRANSFORM_ALL=%s", (transformAll) => {
  const env = { OXC_TRANSFORM_ALL: transformAll };
  const addonDep = () =>
    fixture({
      "package.json": COMMONJS,
      "node_modules/addon-dep/package.json": JSON.stringify({
        name: "addon-dep",
        main: "addon.node",
      }),
      "node_modules/addon-dep/addon.node": readFileSync(join(CORE, addon!)),
      "entry.mts": ADDON_DEP_ENTRY,
    });

  test.skipIf(addon === undefined)("an addon still loads with --experimental-addon-modules", () => {
    // Not specific to the synchronous hooks — the asynchronous default load returned the
    // same `null`. Node.js decides `addon` and hands the load hook `source: null`; its
    // `addon` translator asserts exactly `null` on the way back, and an `undefined`, which
    // is what a dropped `Option` serialised to, fails with ERR_INVALID_RETURN_PROPERTY_VALUE.
    expect(run(addonDep(), ["--experimental-addon-modules", "./entry.mts"], env)).toContain(
      "addon: function",
    );
  });

  test.skipIf(addon === undefined || nodeMajor === 23 || nodeMajor === 25)(
    "an addon follows Node.js' own default for the flag",
    () => {
      // With the flag off Node.js reports no format for the file — `format: undefined`,
      // which the load context has to accept — so the load hook short-circuits to
      // `nextLoad` and Node.js' own error is what shows, exactly as without oxc-node.
      if (addonImportsByDefault) {
        expect(run(addonDep(), ["./entry.mts"], env)).toContain("addon: function");
      } else {
        runFailing(addonDep(), ["./entry.mts"], "ERR_UNKNOWN_FILE_EXTENSION", env);
      }
    },
  );

  test("a latin-1 CommonJS file still loads", () => {
    // The UTF-8 check in `transform_output` runs before the node_modules skip, so a
    // dependency is deferred to the CommonJS machinery the same way a local file is.
    const root = fixture({
      "package.json": COMMONJS,
      "node_modules/latin-dep/package.json": JSON.stringify({
        name: "latin-dep",
        main: "index.js",
      }),
      "node_modules/latin-dep/index.js": LATIN1_SOURCE,
      "entry.mts": [
        'import legacy from "latin-dep";',
        'console.log("latin1:", legacy.length);',
      ].join("\n"),
    });
    expect(run(root, ["./entry.mts"], env)).toContain("latin1: 4");
  });

  test("a `.cts` file gets Node.js' own type-stripping error, not one blaming the hook", () => {
    // `.cts` under node_modules is `commonjs-typescript` to Node.js, a format whose
    // translator needs the source: deferring it with `source: null` like plain `commonjs`
    // is an invalid return shape. Node.js refuses type stripping in node_modules on every
    // path, so what has to hold is that *its* error is the one reported.
    const root = fixture({
      "package.json": COMMONJS,
      "node_modules/ts-dep/package.json": JSON.stringify({
        name: "ts-dep",
        exports: "./index.cts",
      }),
      "node_modules/ts-dep/index.cts": "const c: number = 3;\nexport { c };\n",
      "entry.mts": ['import { c } from "ts-dep";', 'console.log("cts:", c);'].join("\n"),
    });
    runFailing(root, ["./entry.mts"], "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", env);
  });

  test("an `.mts` file gets Node.js' own type-stripping error, not one blaming the hook", () => {
    // `module-typescript` is the sibling of `commonjs-typescript`; it is never deferred
    // and has to stay passed through with its source.
    const root = fixture({
      "package.json": COMMONJS,
      "node_modules/mts-dep/package.json": JSON.stringify({
        name: "mts-dep",
        exports: "./index.mts",
      }),
      "node_modules/mts-dep/index.mts": "export const c: number = 3;\n",
      "entry.mts": ['import { c } from "mts-dep";', 'console.log("mts:", c);'].join("\n"),
    });
    runFailing(root, ["./entry.mts"], "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING", env);
  });
});

// `--conditions` adds to the condition set of every request, so neither `require` nor
// `import` says anything about which loader asked. Both directions have to keep working
// with either one of them injected.
describe.each(["require", "import"])("with --conditions=%s", (condition) => {
  const flag = `--conditions=${condition}`;

  test("an import is still resolved by oxc-node", () => {
    // Only oxc-node's resolver completes an extensionless specifier for an `import`;
    // Node.js' ESM resolver reports ERR_MODULE_NOT_FOUND.
    const root = fixture({
      "package.json": COMMONJS,
      "dep.ts": 'const value: string = "dep-ok";\nexport default value;\n',
      "entry.mts": ['import dep from "./dep";', 'console.log("import:", dep);'].join("\n"),
    });
    expect(run(root, [flag, "./entry.mts"])).toContain("import: dep-ok");
  });

  test("an imported CommonJS-reported file with ESM syntax still flips to module", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "flip.ts": 'export const flip = "flip-ok";\n',
      "entry.mts": ['import { flip } from "./flip.ts";', 'console.log("flip:", flip);'].join("\n"),
    });
    expect(run(root, [flag, "./entry.mts"])).toContain("flip: flip-ok");
  });

  test("`require()` is still resolved by Node.js", () => {
    const root = fixture({
      "package.json": COMMONJS,
      "dep.ts": 'const value: string = "dep-ok";\nexports.dep = value;\n',
      "entry.ts": ['const { dep } = require("./dep");', 'console.log("require:", dep);'].join("\n"),
    });
    expect(run(root, [flag, "./entry.ts"])).toContain("require: dep-ok");
  });
});
