import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * With `dep.js` beside `dep.ts`, both `./dep.js` and `./dep` used to resolve to
 * `dep.js`, so a project that compiles in place, or keeps generated `.js` next to
 * its sources, ran stale output; tsc and tsx resolve both to `dep.ts`. And `./x.js`
 * mapped to `x.tsx` but not to `x.jsx` (issue #840). Imports from TypeScript files
 * outside `node_modules` now resolve TypeScript first; a package keeps running what
 * it compiled. The entry point and JavaScript importers run the file they name,
 * as Node.js and tsx do (issue #878).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-extension-order-"));
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
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const value = (v: string) => `export const v: string = ${JSON.stringify(v)};\n`;

describe("TypeScript resolves before JavaScript outside node_modules", () => {
  test("`./dep.js` and `./dep` pick `dep.ts` over `dep.js`", () => {
    const root = fixture({
      "dep.js": "export const v = 'js';\n",
      "dep.ts": value("ts"),
      "main.ts": [
        "import { v as a } from './dep.js';",
        "import { v as b } from './dep';",
        "console.log(a, b);",
      ].join("\n"),
    });
    expect(run(root, "./main.ts")).toBe("ts ts\n");
  });

  test("`./dep.mjs` picks `dep.mts`, `./dep.cjs` picks `dep.cts`", () => {
    const root = fixture({
      "dep.mjs": "export const v = 'mjs';\n",
      "dep.mts": value("mts"),
      "dep.cjs": "exports.v = 'cjs';\n",
      "dep.cts": "exports.v = 'cts';\n",
      "main.ts": [
        "import { v as a } from './dep.mjs';",
        "import { v as b } from './dep.cjs';",
        "console.log(a, b);",
      ].join("\n"),
    });
    expect(run(root, "./main.ts")).toBe("mts cts\n");
  });

  test("`./dep.js` and `./dep` find `dep.jsx`", () => {
    const root = fixture({
      "dep.jsx": "export const v = 'jsx';\n",
      "main.ts": [
        "import { v as a } from './dep.js';",
        "import { v as b } from './dep';",
        "console.log(a, b);",
      ].join("\n"),
    });
    expect(run(root, "./main.ts")).toBe("jsx jsx\n");
  });

  // `.tsx` before `.ts`, the other way round from `./dep.js`, as tsc and tsx resolve it.
  test("`./dep.jsx` picks `dep.tsx` over `dep.ts` and `dep.jsx`; `./util.jsx` finds `util.ts`", () => {
    const root = fixture({
      "dep.jsx": "export const v = 'jsx';\n",
      "dep.tsx": value("tsx"),
      "dep.ts": value("ts"),
      "util.ts": value("ts"),
      "main.ts": [
        "import { v as a } from './dep.jsx';",
        "import { v as b } from './util.jsx';",
        "console.log(a, b);",
      ].join("\n"),
    });
    expect(run(root, "./main.ts")).toBe("tsx ts\n");
  });

  test("a JavaScript file alone still resolves", () => {
    const root = fixture({
      "dep.js": "export const v = 'js';\n",
      "main.ts":
        "import { v as a } from './dep.js';\nimport { v as b } from './dep';\nconsole.log(a, b);\n",
    });
    expect(run(root, "./main.ts")).toBe("js js\n");
  });

  test("a package keeps running its compiled JavaScript", () => {
    // The package ships its `.ts` sources beside the compiled `.js`, which is
    // what it runs — from the project's bare import and from its own imports.
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        type: "module",
        main: "./index",
      }),
      "node_modules/pkg/index.js": "export const v = 'js';\nexport { w } from './inner.js';\n",
      "node_modules/pkg/index.ts": value("ts"),
      "node_modules/pkg/inner.js": "export const w = 'js';\n",
      "node_modules/pkg/inner.ts": "export const w: string = 'ts';\n",
      "main.ts": "import { v, w } from 'pkg';\nconsole.log(v, w);\n",
    });
    expect(run(root, "./main.ts")).toBe("js js\n");
  });

  test("a package keeps its compiled `.mjs` over a `.jsx` source", () => {
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        type: "module",
        main: "./index",
      }),
      "node_modules/pkg/index.mjs": "export const v = 'mjs';\n",
      "node_modules/pkg/index.jsx": "export const v = 'jsx';\n",
      "main.ts": "import { v } from 'pkg';\nconsole.log(v);\n",
    });
    expect(run(root, "./main.ts")).toBe("mjs\n");
  });
});

describe("the entry point and JavaScript importers run the file they name (issue #878)", () => {
  test.each([
    ["./main.js", "main.js", "main.ts"],
    ["./main.mjs", "main.mjs", "main.mts"],
    ["./main.cjs", "main.cjs", "main.cts"],
    ["./main.jsx", "main.jsx", "main.tsx"],
    ["./main", "main.js", "main.ts"],
  ])("the entry %s runs %s, not %s", (entry, named, sibling) => {
    const root = fixture({ [named]: "console.log('JS');\n", [sibling]: "console.log('TS');\n" });
    expect(run(root, entry)).toBe("JS\n");
  });

  test.each([
    ["./main.js", "main.ts"],
    ["./main.mjs", "main.mts"],
    ["./main.cjs", "main.cts"],
    ["./main.jsx", "main.tsx"],
  ])("the entry %s still runs %s when it is missing", (entry, source) => {
    const root = fixture({ [source]: "console.log('TS');\n" });
    expect(run(root, entry)).toBe("TS\n");
  });

  test.each(["main.js", "main.mjs", "main.cjs"])("%s imports the files it names", (main) => {
    const root = fixture({
      "dep.js": "export const v = 'js';\n",
      "dep.ts": value("ts"),
      "dep.mjs": "export const v = 'mjs';\n",
      "dep.mts": value("mts"),
      "dep.cjs": "exports.v = 'cjs';\n",
      "dep.cts": "exports.v = 'cts';\n",
      "dep.jsx": "export const v = 'jsx';\n",
      "dep.tsx": value("tsx"),
      [main]:
        "Promise.all(['./dep.js', './dep.mjs', './dep.cjs', './dep.jsx', './dep'].map((s) => import(s)))" +
        ".then((ms) => console.log(ms.map((m) => m.v).join(' ')));\n",
    });
    // An extensionless `./dep` stays TypeScript first, as tsx resolves it.
    expect(run(root, `./${main}`)).toBe("js mjs cjs jsx ts\n");
  });

  test("a JavaScript importer still finds TypeScript when the named file is missing", () => {
    const root = fixture({
      "a.ts": value("ts"),
      "b.mts": value("mts"),
      "c.tsx": value("tsx"),
      "main.js": [
        "import { v as a } from './a.js';",
        "import { v as b } from './b.mjs';",
        "import { v as c } from './c.jsx';",
        "console.log(a, b, c);",
      ].join("\n"),
    });
    expect(run(root, "./main.js")).toBe("ts mts tsx\n");
  });

  test("a `.jsx` importer stays TypeScript first, as tsx counts it", () => {
    const root = fixture({
      "dep.js": "export const v = 'js';\n",
      "dep.ts": value("ts"),
      "main.jsx": "import { v } from './dep.js';\nconsole.log(v);\n",
    });
    expect(run(root, "./main.jsx")).toBe("ts\n");
  });

  test("a package imported from JavaScript keeps running its compiled JavaScript", () => {
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        type: "module",
        main: "./index",
      }),
      "node_modules/pkg/index.js": "export const v = 'js';\nexport { w } from './inner.js';\n",
      "node_modules/pkg/index.ts": value("ts"),
      "node_modules/pkg/inner.js": "export const w = 'js';\n",
      "node_modules/pkg/inner.ts": "export const w: string = 'ts';\n",
      "main.js": "import { v, w } from 'pkg';\nconsole.log(v, w);\n",
    });
    expect(run(root, "./main.js")).toBe("js js\n");
  });

  test("the importer resolves `./cfg.js` from a directory to `cfg.js`", () => {
    const root = fixture({
      "cfg.js": "export const v = 'js';\n",
      "cfg.ts": value("ts"),
      "probe.mjs": [
        "import { createImporter } from '@oxc-node/core/importer';",
        "const resolved = createImporter(process.cwd() + '/').resolve('./cfg.js');",
        "console.log(/[\\\\/]cfg\\.js$/.test(String(resolved)));",
      ].join("\n"),
    });
    expect(run(root, "./probe.mjs")).toBe("true\n");
  });
});
