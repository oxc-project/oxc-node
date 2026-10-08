import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * `compilerOptions.jsx` holds `tsc`'s enum values — `react`, `react-jsx`, `react-jsxdev`,
 * `preserve` and `react-native` — not the Babel runtime names `automatic`/`classic` the
 * transformer used to match against. Every real value therefore fell through to the
 * automatic production runtime (issue #796): `"jsx": "react"` ignored `jsxFactory` and
 * emitted an import of `react/jsx-runtime`, which fails at runtime with
 * `ERR_MODULE_NOT_FOUND`, and `"jsx": "react-jsxdev"` emitted `jsx` from
 * `jsx-runtime` instead of `jsxDEV` from `jsx-dev-runtime`.
 *
 * | `jsx`           | runtime   | development |
 * | --------------- | --------- | ----------- |
 * | `react`         | classic   | `false`     |
 * | `react-jsx`     | automatic | `false`     |
 * | `react-jsxdev`  | automatic | `true`      |
 * | `preserve`      | automatic | `false`     |
 * | `react-native`  | automatic | `false`     |
 * | unset / unknown | automatic | `false`     |
 *
 * `preserve` and `react-native` deliberately fall back to the automatic runtime: `tsc`
 * preserves JSX syntax for both (emitting `.jsx` for `preserve`, `.js` for
 * `react-native`), and Node.js cannot run untransformed JSX — so automatic is the
 * useful equivalent here.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

// Prints what the transformer emits for one file, so a spec can assert on the output
// itself. The transform API targets CommonJS, so the assertions below look for
// `require(...)`, never `import` syntax.
const DUMP = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OxcTransformer } from "@oxc-node/core";
const file = resolve(process.argv[2]);
const transformer = new OxcTransformer(process.cwd());
console.log(transformer.transform(file, readFileSync(file, "utf8")).source());
`;

// The resolver and its tsconfig are memoised in a process-wide `OnceLock`, so every
// scenario needs its own subprocess with its own working directory.
const createProject = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "oxc-jsx-runtime-"));
  roots.push(root);
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(
    CORE,
    join(root, "node_modules", "@oxc-node", "core"),
    // `junction` is the only link type Windows allows without elevated privileges.
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(join(root, "dump.mjs"), DUMP);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
};

// Node itself writes to stderr for reasons that have nothing to do with the scenario
// under test — the `test-wasi` CI job runs the whole suite with `NAPI_RS_FORCE_WASI=true`
// and loading the WASI binding makes every subprocess print `ExperimentalWarning: WASI is
// an experimental feature`, which would fail each `stderr` assertion below even though
// the run succeeded. Drop Node's own warnings and keep everything else, so a real error
// still fails the test.
const stripNodeWarnings = (stderr: string) =>
  stderr
    .split("\n")
    .filter(
      (line) =>
        !line.includes("ExperimentalWarning") && !line.includes("Use `node --trace-warnings"),
    )
    .join("\n")
    .trim();

const runNode = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      // Continuous integration sets both globally, and the tracing layer writes to
      // stdout, which would drown the assertions below. An explicit tsconfig from the
      // environment would silently shadow each fixture's own tsconfig.json.
      OXC_LOG: undefined,
      DEBUG: undefined,
      TS_NODE_PROJECT: undefined,
      OXC_TSCONFIG_PATH: undefined,
      ...env,
    },
    timeout: 30_000,
  });
  return { ...result, stderr: stripNodeWarnings(result.stderr) };
};

/** The code the transformer emits for `entry`, run from `root`. */
const emit = (root: string, entry: string) => runNode(root, [join(root, "dump.mjs"), entry]);

/** Runs `entry` through the ESM resolve and load hooks. */
const runWithHooks = (root: string, entry: string) =>
  runNode(root, ["--import", "@oxc-node/core/register", entry]);

const tsconfig = (compilerOptions: Record<string, unknown>) => JSON.stringify({ compilerOptions });

// All fixtures are `.tsx`: JSX syntax does not parse as `.ts`.
const JSX_ELEMENT = 'export const el = <div id="a" className="b" />;\n';

describe("compilerOptions.jsx", () => {
  test('"react" honours jsxFactory and never imports a jsx-runtime', () => {
    const root = createProject({
      "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h", target: "ES2022" }),
      "entry.tsx": JSX_ELEMENT,
    });

    const emitted = emit(root, "./entry.tsx");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout, "the classic runtime should call the jsxFactory").toContain("h(");
    expect(emitted.stdout, "no jsx-runtime import may be emitted").not.toContain("jsx-runtime");
  });

  test('"react" output runs: the jsxFactory receives the element', () => {
    const root = createProject({
      "tsconfig.json": tsconfig({ jsx: "react", jsxFactory: "h", target: "ES2022" }),
      "entry.tsx": `const h = (...a: any[]) => (console.log("CLASSIC:" + a[0]), null);
console.log(h(<div />));
`,
    });

    // Pre-fix this failed with ERR_MODULE_NOT_FOUND for `react/jsx-runtime` — the exact
    // report from issue #796.
    const ran = runWithHooks(root, "./entry.tsx");
    expect(ran.stderr, "the fixture should run without a jsx-runtime import").toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout, "the jsxFactory should be called with the tag name").toContain(
      "CLASSIC:div",
    );
  });

  test('"react-jsxdev" imports jsxDEV from {jsxImportSource}/jsx-dev-runtime', () => {
    const root = createProject({
      "tsconfig.json": tsconfig({
        jsx: "react-jsxdev",
        jsxImportSource: "preact",
        target: "ES2022",
      }),
      "entry.tsx": JSX_ELEMENT,
    });

    const emitted = emit(root, "./entry.tsx");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toContain("preact/jsx-dev-runtime");
    expect(emitted.stdout).toContain("jsxDEV");
    // `fileName` is the field the jsx_source plugin adds — only reachable when
    // `development: true` made `conform()` enable it.
    expect(emitted.stdout).toContain("fileName");
    expect(emitted.stdout, "the production runtime must not be imported").not.toContain(
      "preact/jsx-runtime",
    );
  });

  test('"react-jsx" stays on the automatic production runtime', () => {
    const root = createProject({
      "tsconfig.json": tsconfig({ jsx: "react-jsx", target: "ES2022" }),
      "entry.tsx": JSX_ELEMENT,
    });

    const emitted = emit(root, "./entry.tsx");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toContain("react/jsx-runtime");
    expect(emitted.stdout).toMatch(/jsx[s]?\(/);
    expect(emitted.stdout).not.toContain("jsx-dev-runtime");
    expect(emitted.stdout).not.toContain("jsxDEV");
  });

  test.each(["preserve", "react-native"])(
    '"%s" falls back to the automatic runtime — Node cannot run tsc\'s output for it',
    (jsx) => {
      const root = createProject({
        "tsconfig.json": tsconfig({ jsx, target: "ES2022" }),
        "entry.tsx": JSX_ELEMENT,
      });

      const emitted = emit(root, "./entry.tsx");
      expect(emitted.stderr, "dump should not fail").toBe("");
      expect(emitted.stdout).toContain("react/jsx-runtime");
      expect(emitted.stdout).not.toContain("<div");
    },
  );

  test("the jsx value matches case-insensitively, like tsc's enum parsing", () => {
    const root = createProject({
      "tsconfig.json": tsconfig({ jsx: "REACT-JSXDEV", target: "ES2022" }),
      "entry.tsx": JSX_ELEMENT,
    });

    const emitted = emit(root, "./entry.tsx");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toContain("react/jsx-dev-runtime");
    expect(emitted.stdout).toContain("jsxDEV");
  });
});
