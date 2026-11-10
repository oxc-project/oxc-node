import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * In a `"type": "commonjs"` package whose tsconfig `module` emits CommonJS, a file with
 * ES module syntax is compiled to CommonJS, as `tsc` compiles it (#905). Its imports
 * become `require()` calls, which Node.js' CommonJS resolution and the
 * `Module._resolveFilename` patch in `register.mjs` resolve, instead of oxc-node's
 * own resolver that resolved them while the file ran as an ES module. Compiling it
 * must not change which file an import finds, or what a namespace import holds.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

const COMMONJS = JSON.stringify({ name: "fx", private: true, type: "commonjs" });
const NODENEXT = { module: "nodenext" };

function fixture(
  files: Record<string, string>,
  compilerOptions: Record<string, unknown> = NODENEXT,
): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-commonjs-lowering-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), COMMONJS);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions }));
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

function run(root: string, entry: string, nodeArgs: string[] = []): string {
  const result = spawnSync(
    process.execPath,
    [...nodeArgs, "--import", "@oxc-node/core/register", entry],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
        OXC_LOG: undefined,
        OXC_TRANSFORM_ALL: undefined,
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

describe("an ES module compiled to CommonJS", () => {
  test("resolves an import through a tsconfig `paths` alias", () => {
    // As an ES module, the import went through oxc-node's resolver, which applies the
    // tsconfig's `paths`. `require("@lib/value")` must find the same file.
    const root = fixture(
      {
        "lib/value.ts": "export const value: number = 42;\n",
        "main.ts": 'import { value } from "@lib/value";\nconsole.log("value:", value);\n',
      },
      { ...NODENEXT, paths: { "@lib/*": ["./lib/*"] } },
    );
    expect(run(root, "./main.ts")).toContain("value: 42");
  });

  test("resolves an import through a tsconfig `paths` alias ahead of an installed package", () => {
    // oxc-node's resolver, `tsc` and tsx all try `paths` before `node_modules`.
    const root = fixture(
      {
        "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "index.js" }),
        "node_modules/pkg/index.js": 'exports.from = "package";\n',
        "shim/pkg.ts": 'export const from: string = "alias";\n',
        "main.ts": 'import { from } from "pkg";\nconsole.log("from:", from);\n',
      },
      { ...NODENEXT, paths: { pkg: ["./shim/pkg.ts"] } },
    );
    expect(run(root, "./main.ts")).toContain("from: alias");
  });

  test("resolves an extensionless import to `config.ts` beside `config.json`", () => {
    // Node.js' CommonJS resolution tries `.json` before the extensions oxc-node
    // registers. oxc-node's resolver tries TypeScript first, and so does what `tsc`
    // emits: `config.js`, which Node.js tries before `config.json`.
    const root = fixture({
      "config.ts": 'export const source: string = "ts";\n',
      "config.json": JSON.stringify({ source: "json" }),
      "main.ts": 'import { source } from "./config";\nconsole.log("source:", source);\n',
    });
    expect(run(root, "./main.ts")).toContain("source: ts");
  });

  test.each([
    ["`./component.js` to `component.jsx`", "component.jsx", "./component.js"],
    ["`./component.jsx` to `component.js`", "component.js", "./component.jsx"],
  ])("resolves %s when only it exists", (_what, file, specifier) => {
    // oxc-node's resolver maps `.js` to `.ts`, `.tsx`, `.js` and `.jsx`, and `.jsx`
    // to `.tsx`, `.ts`, `.jsx` and `.js` (#840).
    const root = fixture(
      {
        [file]: 'export const name = "component";\n',
        "main.ts": `import { name } from ${JSON.stringify(specifier)};\nconsole.log("name:", name);\n`,
      },
      { ...NODENEXT, allowJs: true },
    );
    expect(run(root, "./main.ts")).toContain("name: component");
  });

  test("resolves `./component.js` to `component.js` beside `component.jsx`", () => {
    // `.jsx` is a fallback for a missing `.js` file, not a source that wins over it.
    const root = fixture(
      {
        "component.js": 'exports.name = "js";\n',
        "component.jsx": 'export const name = "jsx";\n',
        "main.ts": 'import { name } from "./component.js";\nconsole.log("name:", name);\n',
      },
      { ...NODENEXT, allowJs: true },
    );
    expect(run(root, "./main.ts")).toContain("name: js");
  });

  test("keeps a CommonJS module's non-enumerable exports in a namespace import", () => {
    // `cjs-module-lexer` detects `Object.defineProperty(exports, "value", { value })`,
    // so an ES module's namespace import has `value`, enumerable or not. `tsc`'s
    // `__importStar` copies every own property name too.
    const root = fixture({
      "legacy.cjs": [
        'Object.defineProperty(exports, "value", { value: 42 });',
        "exports.visible = 1;",
      ].join("\n"),
      "main.ts": [
        'import * as legacy from "./legacy.cjs";',
        'console.log("value:", legacy.value, "visible:", legacy.visible);',
      ].join("\n"),
    });
    expect(run(root, "./main.ts")).toContain("value: 42 visible: 1");
  });
});

describe("a TypeScript file in a CommonJS package", () => {
  test("resolves a `require()` through a tsconfig `paths` alias", () => {
    // `require()` and an import compiled to it cannot be told apart, and `tsc` resolves
    // `import x = require()` through `paths` too.
    const root = fixture(
      {
        "lib/value.ts": "export const value: number = 42;\n",
        "main.ts": 'const { value } = require("@lib/value");\nconsole.log("value:", value);\n',
      },
      { ...NODENEXT, paths: { "@lib/*": ["./lib/*"] } },
    );
    expect(run(root, "./main.ts")).toContain("value: 42");
  });

  test.each([
    ["the path `require.resolve()` returns", 'require.resolve("pkg")'],
    ["a relative path into `node_modules`", '"./node_modules/pkg/lib.js"'],
  ])("runs a package's compiled file when it requires %s", (_what, request) => {
    // A package that ships `lib.ts` beside its compiled `lib.js` runs `lib.js`, as the
    // ES module resolver keeps it. Node.js refuses to strip the types of a `.ts` file
    // inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "lib.js" }),
      "node_modules/pkg/lib.js": 'exports.from = "js";\n',
      "node_modules/pkg/lib.ts": 'export const from: string = "ts";\n',
      "main.ts": `const lib = require(${request});\nconsole.log("from:", lib.from);\n`,
    });
    expect(run(root, "./main.ts")).toContain("from: js");
  });

  test.each([
    ["a package `imports` entry", "#value", { imports: { "#value": "./value.js" } }],
    ["a self-reference through `exports`", "fx/value", { exports: { "./value": "./value.js" } }],
  ])("resolves %s that names compiled output to its source", (_what, specifier, fields) => {
    // Node.js maps the request to `./value.js` and stops there; the ES module resolver
    // tried `value.ts` after mapping it.
    const root = fixture({
      "package.json": JSON.stringify({ ...JSON.parse(COMMONJS), ...fields }),
      "value.ts": 'export const value: string = "ts";\n',
      "main.ts": `import { value } from ${JSON.stringify(specifier)};\nconsole.log("value:", value);\n`,
    });
    expect(run(root, "./main.ts")).toContain("value: ts");
  });

  test.each([
    ["a package `imports` entry", "#value", { imports: { "#value": "./value.js" } }],
    ["a self-reference through `exports`", "fx/value", { exports: { "./value": "./value.js" } }],
  ])("resolves %s to its source before compiled output beside it", (_what, specifier, fields) => {
    // The ES module resolver tried `value.ts` before `value.js` after mapping it.
    const root = fixture({
      "package.json": JSON.stringify({ ...JSON.parse(COMMONJS), ...fields }),
      "value.js": 'exports.value = "js";\n',
      "value.ts": 'export const value: string = "ts";\n',
      "main.ts": `import { value } from ${JSON.stringify(specifier)};\nconsole.log("value:", value);\n`,
    });
    expect(run(root, "./main.ts")).toContain("value: ts");
  });

  test("resolves a directory's `main` to its source before the directory's index", () => {
    // Node.js finds `main` missing and falls back to `index.js`; the ES module resolver
    // tried `src/main.ts` for it first.
    const root = fixture({
      "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src/main.js" }),
      "lib/src/main.ts": 'export const where: string = "src/main.ts";\n',
      "lib/index.js": 'exports.where = "index.js";\n',
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toContain("where: src/main.ts");
  });

  test("resolves a directory import to `index.ts` beside `index.json`", () => {
    // Node.js tries `index.json` before the extensions oxc-node registers.
    const root = fixture({
      "barrel/index.ts": 'export const where: string = "index.ts";\n',
      "barrel/index.json": JSON.stringify({ where: "index.json" }),
      "main.ts": 'import { where } from "./barrel";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toContain("where: index.ts");
  });

  test("keeps a directory's `main` when it names the index file", () => {
    // `index.cjs` is the entry `main` names, not a fallback; `.cjs` aliases only `.cts`.
    const root = fixture({
      "lib/package.json": JSON.stringify({ main: "./index.cjs" }),
      "lib/index.cjs": 'exports.where = "index.cjs";\n',
      "lib/index.ts": 'export const where: string = "index.ts";\n',
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toMatch(/^where: index\.cjs$/m);
  });

  test("resolves a directory's extensionless `main` in the ES module resolver's order", () => {
    // Node.js completes `./src/entry` with `.json` before the extensions oxc-node
    // registers; the ES module resolver found `entry.ts` first.
    const root = fixture({
      "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src/entry" }),
      "lib/src/entry.ts": 'export const where: string = "entry.ts";\n',
      "lib/src/entry.json": JSON.stringify({ where: "entry.json" }),
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toMatch(/^where: entry\.ts$/m);
  });

  test("keeps `#` in a require()'s file name, as Node.js does", () => {
    // `dep.js#missing` names a file that is not there, not `dep.js` with a fragment.
    const root = fixture({
      "dep.js": 'exports.where = "dep.js";\n',
      "main.cts":
        'try { console.log("where:", require("./dep.js#missing").where); }\n' +
        'catch (error) { console.log("code:", (error as { code?: string }).code); }\n',
    });
    expect(run(root, "./main.cts")).toMatch(/^code: MODULE_NOT_FOUND$/m);
  });

  test("resolves an extensionless import in the ES module resolver's order", () => {
    // Node.js tries the registered extensions in its own order and finds `dep.jsx`;
    // the ES module resolver found `dep.ts` first.
    const root = fixture(
      {
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "dep.tsx": 'export const where: string = "dep.tsx";\n',
        "dep.jsx": 'export const where = "dep.jsx";\n',
        "main.ts": 'import { where } from "./dep";\nconsole.log("where:", where);\n',
      },
      { ...NODENEXT, allowJs: true, jsx: "react-jsx" },
    );
    expect(run(root, "./main.ts")).toMatch(/^where: dep\.ts$/m);
  });

  test("resolves a package `imports` entry with the active conditions", () => {
    // Node.js picks `./dev.js` under `--conditions=development`, so its source is
    // `dev.ts`, not the `default` target's.
    const root = fixture({
      "package.json": JSON.stringify({
        ...JSON.parse(COMMONJS),
        imports: { "#value": { development: "./dev.js", default: "./prod.js" } },
      }),
      "dev.ts": 'export const value: string = "dev";\n',
      "prod.ts": 'export const value: string = "prod";\n',
      "main.ts": 'import { value } from "#value";\nconsole.log("value:", value);\n',
    });
    expect(run(root, "./main.ts")).toContain("value: prod");
    expect(run(root, "./main.ts", ["--conditions=development"])).toContain("value: dev");
  });

  test("resolves a compiled JavaScript file's extensionless import TypeScript first", () => {
    // As an ES module, `main.js` found `dep.ts` before `dep.js` beside it.
    const root = fixture(
      {
        "dep.js": 'exports.name = "js";\n',
        "dep.ts": 'export const name: string = "ts";\n',
        "main.js": 'import { name } from "./dep";\nconsole.log("name:", name);\n',
      },
      { ...NODENEXT, allowJs: true },
    );
    expect(run(root, "./main.js")).toContain("name: ts");
  });

  test("keeps a hand-written CommonJS file's extensionless require() on Node.js' order", () => {
    const root = fixture(
      {
        "dep.js": 'exports.name = "js";\n',
        "dep.ts": 'export const name: string = "ts";\n',
        "main.js": 'console.log("name:", require("./dep").name);\n',
      },
      { ...NODENEXT, allowJs: true },
    );
    expect(run(root, "./main.js")).toContain("name: js");
  });

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "loads a symlinked source once, whichever name reaches it",
    () => {
      const root = fixture({
        "real.ts": "export const object = {};\n",
        "alias.js": "exports.object = {};\n",
        "main.ts":
          'import { object as viaAlias } from "./alias.js";\n' +
          'import { object as viaReal } from "./real.ts";\n' +
          'console.log("same:", viaAlias === viaReal);\n',
      });
      symlinkSync("real.ts", join(root, "alias.ts"));
      expect(run(root, "./main.ts")).toContain("same: true");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a symlinked output, not beside its target",
    () => {
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        "alias.ts": 'export const where: string = "alias.ts";\n',
        "main.ts":
          'import { where } from "./alias.js";\n' +
          'import { where as extensionless } from "./alias";\n' +
          'console.log("where:", where, extensionless);\n',
      });
      symlinkSync(join("build", "real.js"), join(root, "alias.js"));
      expect(run(root, "./main.ts")).toContain("where: alias.ts alias.ts");
    },
  );
});
