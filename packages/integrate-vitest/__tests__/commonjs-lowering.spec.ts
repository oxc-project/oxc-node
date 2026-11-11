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
const [MAJOR, MINOR, PATCH] = process.versions.node.split(".", 3).map(Number);
// Node.js 26.2 and later run the hooks on this thread, as `module.registerHooks()`.
const SYNC_HOOKS = MAJOR > 26 || (MAJOR === 26 && MINOR >= 2);
// oxc-node compiles to CommonJS only where Node.js can `require()` an ES module from a
// file its module loader ran: 22.22.3, 24.8 and later. Elsewhere files stay ES modules.
const LOWERS =
  MAJOR === 22
    ? MINOR > 22 || (MINOR === 22 && PATCH >= 3)
    : MAJOR === 24
      ? MINOR >= 8
      : MAJOR >= 25;

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

function run(
  root: string,
  entry: string,
  nodeArgs: string[] = [],
  env: Record<string, string> = {},
): string {
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
        ...env,
      },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

describe.skipIf(LOWERS)("a Node.js that cannot require() an ES module it loaded", () => {
  test("keeps ES modules, as before", () => {
    const root = fixture({
      "meta.ts": "export const url = import.meta.url.slice(-7);\n",
      "main.ts":
        'import { url } from "./meta";\n' +
        'console.log("format:", typeof require === "undefined" ? "module" : "commonjs", url);\n',
    });
    expect(run(root, "./main.ts")).toContain("format: module meta.ts\n");
  });
});

describe.skipIf(!LOWERS)("a file compiled to CommonJS that imports an ES module", () => {
  // The WASI binding (`NAPI_RS_FORCE_WASI`, the `test-wasi` CI job) loads through
  // `require()` of an ES module itself, so without it nothing loads.
  test.skipIf(process.env.NAPI_RS_FORCE_WASI === "true")(
    "stays an ES module where `require()` of an ES module is off",
    () => {
      const root = fixture({
        "lib.mts": 'export const m = "lib.mts";\n',
        "main.ts":
          'import { m } from "./lib.mjs";\n' +
          'console.log("format:", typeof require === "undefined" ? "module" : "commonjs", m);\n',
      });
      expect(run(root, "./main.ts", ["--no-experimental-require-module"])).toContain(
        "format: module lib.mts\n",
      );
    },
  );

  // As above. A Worker with the feature on loads the addon too, after which the main
  // thread, with it off, still keeps its files ES modules.
  test.skipIf(process.env.NAPI_RS_FORCE_WASI === "true")(
    "keeps that choice per thread, apart from a Worker's",
    () => {
      const root = fixture({
        "lib.mts": 'export const m = "lib.mts";\n',
        "main.ts":
          'import { m } from "./lib.mjs";\n' +
          'console.log("format:", typeof require === "undefined" ? "module" : "commonjs", m);\n',
        "run.mjs":
          'import { Worker } from "node:worker_threads";\n' +
          'const worker = new Worker("process.exit(0)", {\n' +
          "  eval: true,\n" +
          '  execArgv: ["--experimental-require-module", "--import", "@oxc-node/core/register"],\n' +
          "});\n" +
          'await new Promise((resolve) => worker.on("exit", resolve));\n' +
          'await import("./main.ts");\n',
      });
      expect(run(root, "./run.mjs", ["--no-experimental-require-module"])).toContain(
        "format: module lib.mts\n",
      );
    },
  );

  test("tells its namespace from a CommonJS module tagged as one", () => {
    // A real namespace is taken as is; a CommonJS function whose `Symbol.toStringTag` is
    // `"Module"` is still the default export, as under `tsc` with `esModuleInterop`.
    const root = fixture(
      {
        "lib.mts": 'export default "lib.mts default";\n',
        "tagged.cjs":
          'function f() {\n  return "called";\n}\nf[Symbol.toStringTag] = "Module";\nmodule.exports = f;\n',
        "tagged.d.cts": "declare const f: () => string;\nexport = f;\n",
        "main.ts":
          'import lib from "./lib.mjs";\nimport f from "./tagged.cjs";\n' +
          'console.log("result:", lib, f());\n',
      },
      { ...NODENEXT, esModuleInterop: true },
    );
    expect(run(root, "./main.ts")).toContain("result: lib.mts default called\n");
  });

  test("loads it", () => {
    const root = fixture({
      "meta.ts": "export const url = import.meta.url.slice(-7);\n",
      "main.ts":
        'import { url } from "./meta";\n' +
        'console.log("format:", typeof require === "undefined" ? "module" : "commonjs", url);\n',
    });
    expect(run(root, "./main.ts")).toContain("format: commonjs meta.ts\n");
  });
});

describe.skipIf(!LOWERS)("an ES module compiled to CommonJS", () => {
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

describe.skipIf(!LOWERS)("a TypeScript file in a CommonJS package", () => {
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

  test("resolves a directory-valued `main` to its index in the ES module resolver's order", () => {
    const root = fixture({
      "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src" }),
      "lib/src/index.ts": 'export const where: string = "src/index.ts";\n',
      "lib/src/index.json": JSON.stringify({ where: "src/index.json" }),
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toMatch(/^where: src\/index\.ts$/m);
  });

  test("resolves a symlinked directory's index in the ES module resolver's order", () => {
    // Node.js follows `alias` to `real` before it picks `index.json`.
    const root = fixture({
      "real/index.ts": 'export const where: string = "index.ts";\n',
      "real/index.json": JSON.stringify({ where: "index.json" }),
      "main.ts": 'import { where } from "./alias";\nconsole.log("where:", where);\n',
    });
    // `junction` is the only link type Windows allows without elevated privileges.
    symlinkSync(
      join(root, "real"),
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(run(root, "./main.ts")).toMatch(/^where: index\.ts$/m);
  });

  test("keeps `./foo/` on the directory, not a `foo.ts` beside it", () => {
    // A trailing slash names the directory only, for Node.js and `tsc` alike.
    const root = fixture({
      "foo.ts": 'export const where: string = "foo.ts";\n',
      "foo.js": 'exports.where = "foo.js";\n',
      "foo/index.js": 'exports.where = "foo/index.js";\n',
      "main.ts": 'import { where } from "./foo/";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toMatch(/^where: foo\/index\.js$/m);
  });

  test("falls back to the referenced project's `baseUrl` when an alias's files are missing", () => {
    // An explicitly named tsconfig maps the aliases of the project it references that
    // holds the file, and so takes that project's `baseUrl` too.
    const root = fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: NODENEXT,
        files: [],
        references: [{ path: "./app" }],
      }),
      "app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          ...NODENEXT,
          composite: true,
          baseUrl: ".",
          paths: { "lib/*": ["./missing/*"] },
        },
      }),
      "app/lib/value.ts": 'export const where: string = "app/lib/value.ts";\n',
      "app/main.ts": 'import { where } from "lib/value";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./app/main.ts", [], { OXC_TSCONFIG_PATH: "tsconfig.json" })).toMatch(
      /^where: app\/lib\/value\.ts$/m,
    );
  });

  test.each([
    ["a file with a dot in its name", "./src/entry.prod", "src/entry.prod"],
    ["a directory with a dot in its name", "./src.v1", "src.v1/index"],
  ])(
    "resolves a directory's `main` naming %s in the ES module resolver's order",
    (_what, main, stem) => {
      const root = fixture({
        "lib/package.json": JSON.stringify({ type: "commonjs", main }),
        [`lib/${stem}.ts`]: `export const where: string = "${stem}.ts";\n`,
        [`lib/${stem}.json`]: JSON.stringify({ where: `${stem}.json` }),
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      expect(run(root, "./main.ts")).toContain(`where: ${stem}.ts\n`);
    },
  );

  test("leaves require.resolve() with `paths` to Node.js, which searches there", () => {
    const root = fixture(
      {
        "dep.js": 'exports.where = "local dep.js";\n',
        "dep.ts": 'export const where: string = "local dep.ts";\n',
        "other/dep.js": 'exports.where = "other dep.js";\n',
        "only.ts": "export {};\n",
        "empty/.keep": "",
        "src/x.ts": "export {};\n",
        "other/node_modules/@lib/x/package.json": JSON.stringify({ main: "index.js" }),
        "other/node_modules/@lib/x/index.js": 'exports.where = "other @lib/x";\n',
        "main.cts": [
          'const other = __dirname + "/other";',
          "const where = (request: string, paths: string[]) => {",
          "  try {",
          "    return require(require.resolve(request, { paths })).where;",
          "  } catch (error) {",
          "    return (error as { code?: string }).code;",
          "  }",
          "};",
          'console.log("where:", where("./dep.js", [other]));',
          // No source beside the caller when Node.js searched elsewhere.
          'console.log("missing:", where("./only.js", []), where("./only.js", [__dirname + "/empty"]));',
          // No tsconfig alias before the directories it names.
          'console.log("bare:", where("@lib/x", [other]));',
          "export {};",
          "",
        ].join("\n"),
      },
      { ...NODENEXT, paths: { "@lib/*": ["./src/*"] } },
    );
    expect(run(root, "./main.cts")).toContain(
      "where: other dep.js\nmissing: MODULE_NOT_FOUND MODULE_NOT_FOUND\nbare: other @lib/x\n",
    );
  });

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a directory's `main` that is a symlink",
    () => {
      const root = fixture({
        "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src/entry.js" }),
        "lib/dist/real.js": 'exports.where = "dist/real.js";\n',
        "lib/src/entry.ts": 'export const where: string = "src/entry.ts";\n',
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("..", "dist", "real.js"), join(root, "lib", "src", "entry.js"));
      expect(run(root, "./main.ts")).toContain("where: src/entry.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a directory's index file that is a symlink",
    () => {
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        "lib/index.ts": 'export const where: string = "lib/index.ts";\n',
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("..", "build", "real.js"), join(root, "lib", "index.js"));
      expect(run(root, "./main.ts")).toContain("where: lib/index.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source for `./dep` whose `dep.js` links to another extension",
    () => {
      const root = fixture({
        "build/real.cjs": 'exports.where = "build/real.cjs";\n',
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "main.ts": 'import { where } from "./dep";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("build", "real.cjs"), join(root, "dep.js"));
      expect(run(root, "./main.ts")).toContain("where: dep.ts\n");
    },
  );

  test("resolves an extensionless entry compiled to CommonJS TypeScript first", () => {
    const root = fixture({
      "tsconfig.cjs.json": JSON.stringify({ compilerOptions: { module: "commonjs" } }),
      "dep.js": 'exports.where = "stale dep.js";\n',
      "dep.ts": 'export const where: string = "dep.ts";\n',
      "bin/run": 'import { where } from "../dep";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./bin/run", [], { OXC_TSCONFIG_PATH: "./tsconfig.cjs.json" })).toContain(
      "where: dep.ts\n",
    );
  });

  test("finds the source `./foo.js` names before a `foo.js` directory", () => {
    const root = fixture({
      "foo.js/index.js": 'exports.where = "foo.js/index.js";\n',
      "foo.ts": 'export const where: string = "foo.ts";\n',
      "main.ts":
        'import { where } from "./foo.js";\n' +
        'import { where as directory } from "./foo.js/";\n' +
        'console.log("where:", where, directory);\n',
    });
    expect(run(root, "./main.ts")).toContain("where: foo.ts foo.js/index.js\n");
  });

  test("finds the source `./dep.js` names before a `dep.js.json` Node.js completes it with", () => {
    const root = fixture(
      {
        "dep.js.json": JSON.stringify({ where: "dep.js.json" }),
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "jsx.js.json": JSON.stringify({ where: "jsx.js.json" }),
        "jsx.jsx": 'export const where = "jsx.jsx";\n',
        "main.ts":
          'import { where } from "./dep.js";\n' +
          'import { where as jsx } from "./jsx.js";\n' +
          'console.log("where:", where, jsx);\n',
      },
      { ...NODENEXT, allowJs: true },
    );
    expect(run(root, "./main.ts")).toContain("where: dep.ts jsx.jsx\n");
  });

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds a local source before the output it stands for links into node_modules",
    () => {
      const root = fixture({
        "node_modules/pkg/dep.js": 'exports.where = "node_modules/pkg/dep.js";\n',
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "main.ts": 'import { where } from "./dep.js";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("node_modules", "pkg", "dep.js"), join(root, "dep.js"));
      expect(run(root, "./main.ts")).toContain("where: dep.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "resolves a JavaScript file compiled to CommonJS as the ES module resolver did",
    () => {
      const root = fixture(
        {
          "build/real.js": 'exports.where = "build/real.js";\n',
          "lib/index.ts": 'export const where: string = "lib/index.ts";\n',
          "main.js": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
        },
        { ...NODENEXT, allowJs: true },
      );
      symlinkSync(join("..", "build", "real.js"), join(root, "lib", "index.js"));
      expect(run(root, "./main.js")).toContain("where: lib/index.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "keeps a directory's explicit `main` that an unused index links to",
    () => {
      const root = fixture({
        "lib/package.json": JSON.stringify({ type: "commonjs", main: "./index.cjs" }),
        "lib/index.cjs": 'exports.where = "index.cjs";\n',
        "lib/index.ts": 'export const where: string = "index.ts";\n',
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      symlinkSync("index.cjs", join(root, "lib", "index.js"));
      expect(run(root, "./main.ts")).toContain("where: index.cjs\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source of an extensionless `main` Node.js completed through a symlink",
    () => {
      const root = fixture({
        "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src/entry" }),
        "lib/dist/real.js": 'exports.where = "dist/real.js";\n',
        "lib/src/entry.ts": 'export const where: string = "src/entry.ts";\n',
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("..", "dist", "real.js"), join(root, "lib", "src", "entry.js"));
      expect(run(root, "./main.ts")).toContain("where: src/entry.ts\n");
    },
  );

  test("orders the index of a directory `main` that is a symlink", () => {
    const root = fixture({
      "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src" }),
      "lib/real/index.json": JSON.stringify({ where: "real/index.json" }),
      "lib/real/index.ts": 'export const where: string = "real/index.ts";\n',
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    symlinkSync(
      "real",
      join(root, "lib", "src"),
      // `junction` is the only link type Windows allows without elevated privileges.
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(run(root, "./main.ts")).toContain("where: real/index.ts\n");
  });

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds a missing `main`'s source before the source beside a symlinked index",
    () => {
      const root = fixture({
        "lib/package.json": JSON.stringify({ type: "commonjs", main: "./src/main.js" }),
        "lib/src/main.ts": 'export const where: string = "lib/src/main.ts";\n',
        "lib/index.ts": 'export const where: string = "lib/index.ts";\n',
        "build/real.js": 'exports.where = "build/real.js";\n',
        "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("..", "build", "real.js"), join(root, "lib", "index.js"));
      expect(run(root, "./main.ts")).toContain("where: lib/src/main.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a package `imports` target that is a symlink",
    () => {
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        // The target has a source of its own, which the mapped name comes before.
        "build/real.ts": 'export const where: string = "build/real.ts";\n',
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "main.ts": 'import { where } from "#dep";\nconsole.log("where:", where);\n',
      });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ ...JSON.parse(COMMONJS), imports: { "#dep": "./dep.js" } }),
      );
      symlinkSync(join("build", "real.js"), join(root, "dep.js"));
      expect(run(root, "./main.ts")).toContain("where: dep.ts\n");
    },
  );

  // Windows lets only elevated processes create file symlinks. Before Node.js 26.2 the
  // hooks thread resolves the target again, by its own name, and finds `real.ts`.
  test.skipIf(process.platform === "win32" || !SYNC_HOOKS)(
    "keeps a package `imports` target that is a symlink when no source is beside it",
    () => {
      // The ES module resolver tries sources beside `dep.js` only, then follows the link.
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        "build/real.ts": 'export const where: string = "build/real.ts";\n',
        "main.ts": 'import { where } from "#dep";\nconsole.log("where:", where);\n',
      });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ ...JSON.parse(COMMONJS), imports: { "#dep": "./dep.js" } }),
      );
      symlinkSync(join("build", "real.js"), join(root, "dep.js"));
      expect(run(root, "./main.ts")).toContain("where: build/real.js\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds a symlinked source beside a symlinked package `imports` target",
    () => {
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        "shared/source.ts": 'export const where: string = "shared/source.ts";\n',
        "main.ts":
          'import { where } from "#dep";\n' +
          'import { where as relative } from "./dep.js";\n' +
          'console.log("where:", where, relative);\n',
      });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ ...JSON.parse(COMMONJS), imports: { "#dep": "./dep.js" } }),
      );
      symlinkSync(join("build", "real.js"), join(root, "dep.js"));
      symlinkSync(join("shared", "source.ts"), join(root, "dep.ts"));
      expect(run(root, "./main.ts")).toContain("where: shared/source.ts shared/source.ts\n");
    },
  );

  // Windows needs a junction for the workspace link, which `fixture` does not make.
  test.skipIf(process.platform === "win32")(
    "finds a linked workspace package's `main` source before the index Node.js falls back to",
    () => {
      const root = fixture({
        "packages/pkg/package.json": JSON.stringify({
          name: "pkg",
          type: "commonjs",
          main: "./src/main.js",
        }),
        "packages/pkg/index.js": 'exports.where = "index.js";\n',
        "packages/pkg/src/main.ts": 'export const where: string = "src/main.ts";\n',
        "main.ts": 'import { where } from "pkg";\nconsole.log("where:", where);\n',
      });
      symlinkSync(join("..", "packages", "pkg"), join(root, "node_modules", "pkg"), "dir");
      expect(run(root, "./main.ts")).toContain("where: src/main.ts\n");
    },
  );

  // Windows needs a junction for the workspace link, which `fixture` does not make.
  test.skipIf(process.platform === "win32")(
    "finds a workspace package's source from a compiled JavaScript file, not a hand-written one",
    () => {
      const root = fixture(
        {
          "packages/pkg/package.json": JSON.stringify({
            name: "pkg",
            type: "commonjs",
            main: "./src/main",
          }),
          "packages/pkg/src/main.js": 'exports.where = "src/main.js";\n',
          "packages/pkg/src/main.ts": 'export const where: string = "src/main.ts";\n',
          "main.js":
            'import { where } from "pkg";\n' +
            'console.log("where:", where, require("./lib/plain.js"));\n',
          // Another directory: Node.js caches a resolution by its parent's directory.
          "lib/plain.js": 'module.exports = require("pkg").where;\n',
        },
        { ...NODENEXT, allowJs: true },
      );
      symlinkSync(join("..", "packages", "pkg"), join(root, "node_modules", "pkg"), "dir");
      expect(run(root, "./main.js")).toContain("where: src/main.ts src/main.js\n");
    },
  );

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a symlink `--conditions` maps a package `imports` entry to",
    () => {
      const root = fixture({
        "build/real.js": 'exports.where = "build/real.js";\n',
        "prod.js": 'exports.where = "prod.js";\n',
        "dev.ts": 'export const where: string = "dev.ts";\n',
        "main.ts": 'import { where } from "#dep";\nconsole.log("where:", where);\n',
      });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          ...JSON.parse(COMMONJS),
          imports: { "#dep": { development: "./dev.js", default: "./prod.js" } },
        }),
      );
      symlinkSync(join("build", "real.js"), join(root, "dev.js"));
      expect(run(root, "./main.ts", ["--conditions=development"])).toContain("where: dev.ts\n");
      expect(run(root, "./main.ts", [], { NODE_OPTIONS: "-C development" })).toContain(
        "where: dev.ts\n",
      );
    },
  );

  // Windows lets only elevated processes create file symlinks. `require()` takes the
  // `module-sync` branch where it can load an ES module.
  test.skipIf(
    process.platform === "win32" ||
      !(process.features as { require_module?: boolean }).require_module,
  )("finds the source beside a symlink the `module-sync` condition maps to", () => {
    const root = fixture({
      "build/real.js": 'exports.where = "build/real.js";\n',
      "other.js": 'exports.where = "other.js";\n',
      "sync.ts": 'export const where: string = "sync.ts";\n',
      "main.ts": 'import { where } from "#dep";\nconsole.log("where:", where);\n',
    });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        ...JSON.parse(COMMONJS),
        imports: { "#dep": { "module-sync": "./sync.js", default: "./other.js" } },
      }),
    );
    symlinkSync(join("build", "real.js"), join(root, "sync.js"));
    expect(run(root, "./main.ts")).toContain("where: sync.ts\n");
  });

  // Windows lets only elevated processes create file symlinks.
  test.skipIf(process.platform === "win32")(
    "finds the source beside a package `imports` target that links into `node_modules`",
    () => {
      const root = fixture({
        "node_modules/pkg/dep.js": 'exports.where = "pkg/dep.js";\n',
        "dep.ts": 'export const where: string = "dep.ts";\n',
        "main.ts":
          'import { where } from "#dep";\n' +
          'import { where as relative } from "./dep.js";\n' +
          'console.log("where:", where, relative);\n',
      });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ ...JSON.parse(COMMONJS), imports: { "#dep": "./dep.js" } }),
      );
      symlinkSync(join("node_modules", "pkg", "dep.js"), join(root, "dep.js"));
      expect(run(root, "./main.ts")).toContain("where: dep.ts dep.ts\n");
    },
  );

  test("resolves `.` as the directory only, never a file beside it", () => {
    const root = fixture({
      "proj/main.ts": 'import { where } from ".";\nconsole.log("where:", where);\n',
      "proj/index.js": 'exports.where = "proj/index.js";\n',
      "proj.js": 'exports.where = "proj.js";\n',
      "proj.ts": 'export const where: string = "proj.ts";\n',
    });
    expect(run(root, "./proj/main.ts")).toContain("where: proj/index.js\n");
  });

  test("keeps a directory's `main` whose name starts with the request's, as the ES module resolver does", () => {
    const root = fixture({
      "lib/package.json": JSON.stringify({ main: "./src/lib.cjs" }),
      "lib/src/lib.cjs": 'exports.where = "lib.cjs";\n',
      "lib/src/lib.ts": 'export const where: string = "lib.ts";\n',
      "main.ts": 'import { where } from "./lib";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toContain("where: lib.cjs\n");
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

  // Windows reads `\` as a separator, as the ES module resolver does everywhere. Before
  // Node.js 26.2 the hooks load a TypeScript file by URL, where Node.js rejects `%5C`.
  test.skipIf(process.platform === "win32" || !SYNC_HOOKS)(
    "keeps `\\` in a require()'s file name, as Node.js does outside Windows",
    () => {
      const root = fixture({
        "dir\\dep.js": 'exports.where = "dir\\\\dep.js";\n',
        "dir\\dep.ts": 'export const where: string = "dir\\\\dep.ts";\n',
        "dir/dep.ts": 'export const where: string = "dir/dep.ts";\n',
        "main.ts":
          'const { where } = require("./dir\\\\dep.js") as { where: string };\n' +
          'console.log("where:", where);\nexport {};\n',
      });
      expect(run(root, "./main.ts")).toContain("where: dir\\dep.ts\n");
    },
  );

  test("finds a package's source by its output's name, as the ES module resolver does", () => {
    // `pkg` ships `feature.ts` only, which `OXC_TRANSFORM_ALL` compiles: to CommonJS, with
    // the tsconfig named, which Node.js 22.18 can `require()` from a compiled file.
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        version: "1.0.0",
        type: "commonjs",
      }),
      "node_modules/pkg/feature.ts": 'export const feature: string = "pkg/feature.ts";\n',
      "main.ts": 'import { feature } from "pkg/feature.js";\nconsole.log("feature:", feature);\n',
    });
    const env = {
      OXC_TRANSFORM_ALL: "typescript",
      OXC_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    expect(run(root, "./main.ts", [], env)).toContain("feature: pkg/feature.ts\n");
  });

  test("finds a package's `.js` file by a `.jsx` name, as the ES module resolver does", () => {
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
      "node_modules/pkg/feature.js": 'exports.feature = "pkg/feature.js";\n',
      "main.ts": 'import { feature } from "pkg/feature.jsx";\nconsole.log("feature:", feature);\n',
    });
    expect(run(root, "./main.ts")).toContain("feature: pkg/feature.js\n");
  });

  test("finds a package's index source before the `index.json` Node.js finds", () => {
    // The package has no `main`; the ES module resolver tries `index.ts` before JSON.
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        version: "1.0.0",
        type: "commonjs",
      }),
      "node_modules/pkg/index.ts": 'export const where: string = "index.ts";\n',
      "node_modules/pkg/index.json": '{ "where": "index.json" }\n',
      "main.ts": 'import { where } from "pkg";\nconsole.log("where:", where);\n',
    });
    const env = {
      OXC_TRANSFORM_ALL: "typescript",
      OXC_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    expect(run(root, "./main.ts", [], env)).toContain("where: index.ts\n");
  });

  test("finds a package's `index.mjs` before the `index.json` Node.js finds", () => {
    const root = fixture({
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
      "node_modules/pkg/index.mjs": 'export const where = "index.mjs";\n',
      "node_modules/pkg/index.json": '{ "where": "index.json" }\n',
      "main.ts": 'import { where } from "pkg";\nconsole.log("where:", where);\n',
    });
    expect(run(root, "./main.ts")).toContain("where: index.mjs\n");
  });

  test("resolves a compiled dependency's relative import in the package order", () => {
    // `a` compiles to CommonJS with the tsconfig named; `./config` is `config.ts` for it,
    // before the `config.json` Node.js finds, as it was as an ES module.
    const root = fixture(
      {
        "node_modules/a/package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          type: "commonjs",
          main: "main.ts",
        }),
        "node_modules/a/main.ts":
          'import { where } from "./config";\nexport const fromA = where;\n',
        "node_modules/a/config.ts": 'export const where: string = "config.ts";\n',
        "node_modules/a/config.json": '{ "where": "config.json" }\n',
        "main.ts": 'import { fromA } from "a";\nconsole.log("where:", fromA);\n',
      },
      { ...NODENEXT, resolveJsonModule: true },
    );
    const env = {
      OXC_TRANSFORM_ALL: "typescript",
      OXC_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    expect(run(root, "./main.ts", [], env)).toContain("where: config.ts\n");
  });

  test("resolves a compiled dependency's bare import in the package order", () => {
    // `b` has no `main`; `index.ts` comes before the `index.json` Node.js finds.
    const root = fixture(
      {
        "node_modules/a/package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          type: "commonjs",
          main: "main.ts",
        }),
        "node_modules/a/main.ts": 'import { where } from "b";\nexport const fromA = where;\n',
        "node_modules/b/package.json": JSON.stringify({
          name: "b",
          version: "1.0.0",
          type: "commonjs",
        }),
        "node_modules/b/index.ts": 'export const where: string = "b/index.ts";\n',
        "node_modules/b/index.json": '{ "where": "b/index.json" }\n',
        "main.ts": 'import { fromA } from "a";\nconsole.log("where:", fromA);\n',
      },
      { ...NODENEXT, resolveJsonModule: true },
    );
    const env = {
      OXC_TRANSFORM_ALL: "typescript",
      OXC_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    expect(run(root, "./main.ts", [], env)).toContain("where: b/index.ts\n");
  });

  test("resolves a lowered JavaScript dependency's bare import in the package order", () => {
    // `a/main.js` is compiled from an ES module; `a/built.js` is `tsc` output oxc-node
    // leaves alone without `OXC_TRANSFORM_ALL`, and keeps Node.js' answer.
    const root = fixture(
      {
        "node_modules/a/package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          type: "commonjs",
          main: "main.js",
        }),
        "node_modules/a/main.js": 'import { where } from "b";\nexport const fromA = where;\n',
        "node_modules/a/built.js":
          '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n' +
          'exports.fromBuilt = require("b").where;\n',
        "node_modules/b/package.json": JSON.stringify({
          name: "b",
          version: "1.0.0",
          type: "commonjs",
        }),
        "node_modules/b/index.ts": 'export const where: string = "b/index.ts";\n',
        "node_modules/b/index.json": '{ "where": "b/index.json" }\n',
        "main.ts": 'import { fromA } from "a";\nconsole.log("where:", fromA);\n',
        "built.ts": 'import { fromBuilt } from "a/built.js";\nconsole.log("built:", fromBuilt);\n',
      },
      { ...NODENEXT, allowJs: true, resolveJsonModule: true },
    );
    const tsconfig = { OXC_TSCONFIG_PATH: join(root, "tsconfig.json") };
    expect(run(root, "./main.ts", [], { ...tsconfig, OXC_TRANSFORM_ALL: "1" })).toContain(
      "where: b/index.ts\n",
    );
    expect(run(root, "./built.ts", [], tsconfig)).toContain("built: b/index.json\n");
  });

  test("resolves a lowered JavaScript dependency's relative import as an ES module", () => {
    // `./config` finds `config.ts` before `config.json`, and `./lib` the compiled `lib.js`
    // before `lib.ts`; `tsc` output oxc-node leaves alone keeps Node.js' `config.json`.
    const root = fixture(
      {
        "node_modules/a/package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          type: "commonjs",
          main: "main.js",
        }),
        "node_modules/a/main.js":
          'import { where } from "./config";\nimport { lib } from "./lib";\n' +
          "export const fromA = `${where} ${lib}`;\n",
        "node_modules/a/built.js":
          '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n' +
          'exports.fromBuilt = require("./config").where;\n',
        "node_modules/a/config.ts": 'export const where: string = "a/config.ts";\n',
        "node_modules/a/config.json": '{ "where": "a/config.json" }\n',
        "node_modules/a/lib.js": 'export const lib = "a/lib.js";\n',
        "node_modules/a/lib.ts": 'export const lib: string = "a/lib.ts";\n',
        "main.ts": 'import { fromA } from "a";\nconsole.log("where:", fromA);\n',
        "built.ts": 'import { fromBuilt } from "a/built.js";\nconsole.log("built:", fromBuilt);\n',
      },
      { ...NODENEXT, allowJs: true, resolveJsonModule: true },
    );
    const tsconfig = { OXC_TSCONFIG_PATH: join(root, "tsconfig.json") };
    expect(run(root, "./main.ts", [], { ...tsconfig, OXC_TRANSFORM_ALL: "1" })).toContain(
      "where: a/config.ts a/lib.js\n",
    );
    expect(run(root, "./built.ts", [], tsconfig)).toContain("built: a/config.json\n");
  });

  test("resolves a lowered extensionless dependency entry's relative import as an ES module", () => {
    // `bin/run` is a package's entry without an extension; `../config` finds
    // `config.mjs` before the `config.json` Node.js finds.
    const root = fixture(
      {
        "node_modules/a/package.json": JSON.stringify({
          name: "a",
          version: "1.0.0",
          type: "commonjs",
        }),
        "node_modules/a/bin/run":
          'import { where } from "../config";\nconsole.log("where:", typeof require, where);\n',
        "node_modules/a/config.mjs": 'export const where = "a/config.mjs";\n',
        "node_modules/a/config.json": '{ "where": "a/config.json" }\n',
      },
      { ...NODENEXT, allowJs: true, resolveJsonModule: true },
    );
    const env = { OXC_TRANSFORM_ALL: "1", OXC_TSCONFIG_PATH: join(root, "tsconfig.json") };
    expect(run(root, "./node_modules/a/bin/run", [], env)).toContain(
      "where: function a/config.mjs\n",
    );
  });

  test("maps a request with the conditions of Node.js' configuration file", () => {
    // `#dep` takes its `development` branch, as the ES module resolver does, not the
    // `prod.ts` source of its default branch.
    const root = fixture({
      "package.json": JSON.stringify({
        type: "commonjs",
        imports: { "#dep": { development: "./dev.js", default: "./prod.js" } },
      }),
      "node.config.json": JSON.stringify({ nodeOptions: { conditions: ["development"] } }),
      "dev.js": 'exports.where = "dev.js";\n',
      "prod.ts": 'export const where: string = "prod.ts";\n',
      "main.ts": '// @ts-nocheck\nimport { where } from "#dep";\nconsole.log("where:", where);\n',
    });
    for (const args of [
      ["--experimental-config-file=node.config.json"],
      ["--experimental-default-config-file"],
    ]) {
      expect(run(root, "./main.ts", args), args[0]).toContain("where: dev.js\n");
    }
  });

  test("a path request into a package takes the ES module resolver's answer", () => {
    // `pkg` has no `main`: the ES module resolver finds `index.mjs`, Node.js `index.json`.
    // A package's compiled `lib.js` stays before its `lib.ts`, as it does for both.
    const root = fixture(
      {
        "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
        "node_modules/pkg/index.mjs": 'export const where = "pkg/index.mjs";\n',
        "node_modules/pkg/index.json": '{ "where": "pkg/index.json" }\n',
        "node_modules/pkg/lib.js": 'exports.where = "pkg/lib.js";\n',
        "node_modules/pkg/lib.ts": 'export const where = "pkg/lib.ts";\n',
        "main.ts":
          '// @ts-nocheck\nimport { where } from "./node_modules/pkg";\n' +
          'import { where as lib } from "./node_modules/pkg/lib";\n' +
          'console.log("where:", where, lib);\n',
      },
      { ...NODENEXT, allowJs: true, resolveJsonModule: true },
    );
    expect(run(root, "./main.ts")).toContain("where: pkg/index.mjs pkg/lib.js\n");
  });

  test("finds a package's source by its output's name from a compiled dependency", () => {
    // With the tsconfig named, `OXC_TRANSFORM_ALL` compiles `a` to CommonJS too.
    const root = fixture({
      "node_modules/a/package.json": JSON.stringify({
        name: "a",
        version: "1.0.0",
        type: "commonjs",
        main: "index.ts",
      }),
      "node_modules/a/index.ts":
        'import { feature } from "b/feature.js";\nexport const fromA = feature;\n',
      "node_modules/b/package.json": JSON.stringify({
        name: "b",
        version: "1.0.0",
        type: "commonjs",
      }),
      "node_modules/b/feature.ts": 'export const feature: string = "b/feature.ts";\n',
      "main.ts": 'import { fromA } from "a";\nconsole.log("feature:", fromA);\n',
    });
    const env = {
      OXC_TRANSFORM_ALL: "typescript",
      OXC_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    expect(run(root, "./main.ts", [], env)).toContain("feature: b/feature.ts\n");
  });

  test("finds a missing output's source itself, not a file Node.js completes it to", () => {
    // Node.js would complete `./dep.ts` to `dep.ts.json`; `tsc` takes `dep.tsx`.
    const root = fixture(
      {
        "dep.tsx": 'export const where: string = "dep.tsx";\n',
        "dep.ts.json": '{ "where": "dep.ts.json" }\n',
        "main.ts": 'import { where } from "./dep.js";\nconsole.log("where:", where);\n',
      },
      { ...NODENEXT, jsx: "react-jsx" },
    );
    expect(run(root, "./main.ts")).toContain("where: dep.tsx\n");
  });

  test("keeps a file an ES module when a later assignment names a pattern's binding", () => {
    // `a` keeps the name the assignment gives it. An ES module importer, as Node.js 22.18
    // cannot `require()` this ES module from a file compiled to CommonJS.
    const root = fixture({
      "mod.ts":
        "export let [a = 1, b = a]: unknown[] = [];\na = () => 42;\nexport const seen = b;\n",
      "main.mts":
        'import { seen, a } from "./mod.js";\n' +
        'console.log("result:", seen, (a as { name: string }).name);\n',
    });
    expect(run(root, "./main.mts")).toContain("result: 1 a\n");
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

  test("publishes a `var` a block sets before its own declaration", () => {
    // `self.x` reads the export while the module runs: `1`, as under `tsc`.
    const root = fixture({
      "mod.ts":
        'import * as self from "./mod";\n' +
        "if (true) {\n  var x = 1;\n}\n" +
        "export { x };\n" +
        "export const seen = (self as { x?: number }).x;\n" +
        "var x: number;\n",
      "main.ts": 'import { seen } from "./mod";\nconsole.log("seen:", seen);\n',
    });
    expect(run(root, "./main.ts")).toContain("seen: 1\n");
  });

  test("publishes a `var` its own initializer sets", () => {
    // `self.x` reads the export while `x`'s initializer runs: `1`, as under `tsc`.
    const root = fixture({
      "mod.ts":
        'import * as self from "./mod";\n' +
        "export var x: number = ((x = 1), (self as { x?: number }).x as number);\n" +
        "export { x as alias };\n",
      "main.ts": 'import { x, alias } from "./mod";\nconsole.log("x:", x, alias);\n',
    });
    expect(run(root, "./main.ts")).toContain("x: 1 1\n");
  });

  test("calls a parenthesized export without a receiver, and keeps assigned names", () => {
    const root = fixture({
      "mod.ts":
        "function impl(this: unknown) {\n  return this === undefined;\n}\n" +
        "let f = impl;\nexport { f };\nf = impl;\nexport const seen = (f)();\n" +
        "let Handler: unknown;\nHandler = class {};\nexport { Handler };\n" +
        "export const name = (Handler as { name: string }).name;\n",
      "main.ts": 'import { seen, name } from "./mod";\nconsole.log("result:", seen, name);\n',
    });
    expect(run(root, "./main.ts")).toContain("result: true Handler\n");
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
