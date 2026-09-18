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

function run(root: string, args: string[]): string {
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
      },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

describe("a source that is not UTF-8", () => {
  // The loader's own addon is the one binary that is guaranteed to be loadable by the
  // Node.js running these tests; a WASI build of the package has none.
  const addon = readdirSync(CORE).find((name) => name.endsWith(".node"));

  test.skipIf(addon === undefined)("an imported `.node` addon still loads", () => {
    // `.node` resolves as `commonjs`, so the addon arrives at the load hook as a binary
    // blob. Transforming it is not possible and not needed: `process.dlopen` reads the
    // file itself once the CommonJS machinery takes over.
    const root = fixture({
      "package.json": COMMONJS,
      "addon.node": readFileSync(join(CORE, addon!)),
      "entry.mts": [
        'import addon from "./addon.node";',
        'console.log("addon:", typeof addon.transform);',
      ].join("\n"),
    });
    expect(run(root, ["./entry.mts"])).toContain("addon: function");
  });

  test("an imported latin-1 CommonJS file still loads", () => {
    const root = fixture({
      "package.json": COMMONJS,
      // `café` in latin-1: the trailing `0xe9` is not valid UTF-8, and Node.js decodes it
      // to a single replacement character — a four character string either way.
      "legacy.js": Uint8Array.from([
        ...Buffer.from('module.exports = "caf', "utf8"),
        0xe9,
        ...Buffer.from('";\n', "utf8"),
      ]),
      "entry.mts": [
        'import legacy from "./legacy.js";',
        'console.log("latin1:", legacy.length);',
      ].join("\n"),
    });
    expect(run(root, ["./entry.mts"])).toContain("latin1: 4");
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
