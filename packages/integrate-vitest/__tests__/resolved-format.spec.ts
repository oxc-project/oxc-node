import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * The `format` the resolve hook reports decides whether Node.js runs the file as an
 * ES module or as CommonJS. oxc_resolver only consults the nearest `package.json`
 * `"type"` for `.js` and `.ts`, so `.jsx` and `.tsx` arrived with no module type and
 * fell through to `"commonjs"` — in a `"type": "module"` package they ran with
 * `require`/`module` in scope, and a transform that emits `require(".../jsx-runtime")`
 * bypassed the resolve hook entirely, so tsconfig `paths` never applied (issue #797).
 */

const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-format-"));
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

// The format a file ran as, plus the globals that prove it: `require` and `module`
// only exist in a CommonJS scope, and `typeof` does not throw on the missing binding.
const probe = (name: string) =>
  `console.log("${name}:", typeof require === "undefined" ? "module" : "commonjs", typeof require, typeof module);`;

const TYPE_MODULE = JSON.stringify({ name: "fx", private: true, type: "module" });

describe("resolved module format (issue #797)", () => {
  test(".tsx and .jsx in a type:module package run as ES modules", () => {
    const root = fixture({
      "package.json": TYPE_MODULE,
      // No module syntax anywhere: nothing in the source can rescue the format.
      "a.ts": `${probe("a.ts")}\n`,
      "b.tsx": `${probe("b.tsx")}\n`,
      "c.jsx": `${probe("c.jsx")}\n`,
      "entry.ts": [
        'await import("./a.ts");',
        'await import("./b.tsx");',
        'await import("./c.jsx");',
      ].join("\n"),
    });
    const output = run(root, "./entry.ts");
    // `a.ts` is the unaffected control: oxc_resolver already maps it via the
    // package `type`. `.tsx` and `.jsx` are the ones that used to run as CommonJS.
    expect(output).toContain("a.ts: module undefined undefined");
    expect(output).toContain("b.tsx: module undefined undefined");
    expect(output).toContain("c.jsx: module undefined undefined");
  });

  test.each(["./entry.tsx", "./entry.jsx"])(
    "a %s entry point in a type:module package runs as an ES module",
    (entry) => {
      // No parent URL, so the resolve hook uses `resolver.resolve` rather than
      // `resolve_with_context` — a different path to the same format decision.
      const root = fixture({
        "package.json": TYPE_MODULE,
        [entry.slice(2)]: `${probe(entry)}\n`,
      });
      expect(run(root, entry)).toContain(`${entry}: module undefined undefined`);
    },
  );

  test(".tsx and .jsx in a type:commonjs package still run as CommonJS", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "commonjs" }),
      "dep.tsx": `${probe("dep.tsx")}\nexports.dep = true;\n`,
      "dep.jsx": `${probe("dep.jsx")}\nexports.dep = true;\n`,
      "entry.ts": [
        'await import("./dep.tsx");',
        'await import("./dep.jsx");',
        // Top-level await is module syntax, so the entry itself runs as an ES
        // module — the CommonJS assertions belong to the two deps above.
        'console.log("entry:", typeof module !== "undefined" ? typeof module.exports : "n/a");',
      ].join("\n"),
    });
    const output = run(root, "./entry.ts");
    expect(output).toContain("dep.tsx: commonjs function object");
    expect(output).toContain("dep.jsx: commonjs function object");
    expect(output).toContain("entry: n/a");
  });

  test("a package.json without a type field keeps CommonJS", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true }),
      "entry.tsx": `${probe("entry")}\n`,
    });
    expect(run(root, "./entry.tsx")).toContain("entry: commonjs function object");
  });

  test("a tsconfig module:commonjs cannot demote a type:module .tsx file", () => {
    // `compilerOptions.module` only ever promotes toward ESM — for `.ts` it is a
    // hint for files Node.js cannot classify, and the package `type` stays
    // authoritative. `.tsx` now follows the same precedence.
    const root = fixture({
      "package.json": TYPE_MODULE,
      "tsconfig.json": JSON.stringify({ compilerOptions: { module: "CommonJS" } }),
      "entry.tsx": `${probe("entry")}\n`,
    });
    expect(run(root, "./entry.tsx")).toContain("entry: module undefined undefined");
  });

  test("the automatic jsx runtime resolves through tsconfig paths", () => {
    // Reported as CommonJS, the transform emitted `require("my-jsx/jsx-runtime")`,
    // which bypasses the resolve hook and its `paths` — MODULE_NOT_FOUND. As an
    // ES module it emits an `import`, which this resolver completes.
    const root = fixture({
      "package.json": TYPE_MODULE,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "my-jsx",
          paths: { "my-jsx/jsx-runtime": ["./jsx-runtime.ts"] },
          target: "ES2022",
        },
        include: ["entry.tsx", "jsx-runtime.ts"],
      }),
      "jsx-runtime.ts": [
        'export const Fragment = "fragment";',
        "export function jsx(type: any, _props: any) {",
        '  console.log("CUSTOM-RUNTIME:", type);',
        "  return null;",
        "}",
        "export const jsxs = jsx;",
      ].join("\n"),
      "entry.tsx": "console.log(<div />);\n",
    });
    expect(run(root, "./entry.tsx")).toContain("CUSTOM-RUNTIME: div");
  });
});
