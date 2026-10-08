import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * With `"verbatimModuleSyntax": true`, `tsc` — and Node.js' own type stripping —
 * keep every import that is not marked `type`, even when its binding is never
 * referenced: the module's side effects still have to run. `oxc-node` used to
 * remove the unused import, so `polyfill.ts` never executed (issue #798). The
 * tsconfig flag now drives oxc's `only_remove_type_imports`; `import type` and
 * per-specifier `type` modifiers stay elided under both settings.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

// Prints what the transformer emits for one file, so a spec can assert on the output
// itself. The transform API targets CommonJS, but nothing downlevels ESM syntax —
// kept imports stay `import ... from`, and `require(...)` only appears for an
// `import =` lowered by the module transform.
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
  const root = mkdtempSync(join(tmpdir(), "oxc-verbatim-module-syntax-"));
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

// The fixture from issue #798: `installed` is imported but never referenced, so the
// import only exists to run `polyfill.ts`'s side effects.
const POLYFILL_FIXTURE: Record<string, string> = {
  "package.json": '{ "type": "module" }\n',
  "polyfill.ts": `export const installed = true;
(globalThis as any).installed = true;
console.log("polyfill.ts evaluated");
`,
  "main.ts": `import { installed } from "./polyfill.ts";
console.log("main.ts");
`,
};

describe("compilerOptions.verbatimModuleSyntax", () => {
  test("an unused non-type import is emitted and its side effects run", () => {
    const root = createProject({
      ...POLYFILL_FIXTURE,
      "tsconfig.json": tsconfig({ verbatimModuleSyntax: true }),
    });

    const emitted = emit(root, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout, "the unused import must be emitted verbatim").toMatch(
      /import\s*\{\s*installed\s*\}\s*from\s*["']\.\/polyfill\.ts["']/,
    );

    const ran = runWithHooks(root, "./main.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("polyfill.ts evaluated");
    expect(ran.stdout).toContain("main.ts");
    // The polyfill's side effect must run before the importing module's body.
    expect(ran.stdout.indexOf("polyfill.ts evaluated")).toBeLessThan(ran.stdout.indexOf("main.ts"));
  });

  test.each([{}, { verbatimModuleSyntax: false }])(
    "without the flag (%j) the unused import is removed and the polyfill never runs",
    (compilerOptions) => {
      const root = createProject({
        ...POLYFILL_FIXTURE,
        "tsconfig.json": tsconfig(compilerOptions),
      });

      const emitted = emit(root, "./main.ts");
      expect(emitted.stderr, "dump should not fail").toBe("");
      expect(emitted.stdout, "no reference to polyfill.ts may survive").not.toContain("polyfill");

      const ran = runWithHooks(root, "./main.ts");
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain("main.ts");
      expect(ran.stdout).not.toContain("polyfill.ts evaluated");
    },
  );

  test("`import type` stays elided under the flag — nothing is over-preserved", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json": tsconfig({ verbatimModuleSyntax: true }),
      "types.ts": `export type T = number;
console.log("types.ts evaluated");
`,
      "main.ts": `import type { T } from "./types.ts";
const value: T = 1;
console.log("main.ts", value);
`,
    });

    const emitted = emit(root, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).not.toContain("types.ts");

    const ran = runWithHooks(root, "./main.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).not.toContain("types.ts evaluated");
  });

  test("a per-specifier `type` modifier is stripped while the value import survives", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "tsconfig.json": tsconfig(compilerOptions),
      "x.ts": `export type T = number;
export const v = 1;
console.log("x.ts evaluated");
`,
      "main.ts": `import { type T, v } from "./x.ts";
console.log("main.ts");
`,
    });

    const kept = createProject(files({ verbatimModuleSyntax: true }));
    const emitted = emit(kept, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/import\s*\{\s*v\s*\}\s*from\s*["']\.\/x\.ts["']/);
    expect(emitted.stdout).not.toContain("type T");

    const ran = runWithHooks(kept, "./main.ts");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("x.ts evaluated");

    const removed = createProject(files({}));
    const emittedOff = emit(removed, "./main.ts");
    expect(emittedOff.stderr, "dump should not fail").toBe("");
    expect(emittedOff.stdout, "`v` is unused, so the whole import is removed").not.toContain(
      "x.ts",
    );
  });

  test("an all-`type` specifier list becomes a bare side-effect import", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json": tsconfig(compilerOptions),
      "x.ts": `export type A = number;
console.log("x.ts evaluated");
`,
      "main.ts": `import { type A } from "./x.ts";
console.log("main.ts");
`,
    });

    const kept = createProject(files({ verbatimModuleSyntax: true }));
    const emitted = emit(kept, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/import\s*["']\.\/x\.ts["']/);

    const ran = runWithHooks(kept, "./main.ts");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("x.ts evaluated");

    const removed = createProject(files({}));
    const emittedOff = emit(removed, "./main.ts");
    expect(emittedOff.stderr, "dump should not fail").toBe("");
    expect(emittedOff.stdout).not.toContain("x.ts");
  });

  test("unused default and namespace imports are kept verbatim", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "tsconfig.json": tsconfig(compilerOptions),
      "def.ts": `export default 1;
`,
      "ns.ts": `export const a = 1;
`,
      "main.ts": `import def from "./def.ts";
import * as ns from "./ns.ts";
console.log("main.ts");
`,
    });

    const kept = createProject(files({ verbatimModuleSyntax: true }));
    const emitted = emit(kept, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/import\s+def\s+from\s*["']\.\/def\.ts["']/);
    expect(emitted.stdout).toMatch(/import\s+\*\s+as\s+ns\s+from\s*["']\.\/ns\.ts["']/);

    const removed = createProject(files({}));
    const emittedOff = emit(removed, "./main.ts");
    expect(emittedOff.stderr, "dump should not fail").toBe("");
    expect(emittedOff.stdout).not.toContain("def.ts");
    expect(emittedOff.stdout).not.toContain("ns.ts");
  });

  test("the flag is inherited through an `extends` chain", () => {
    const root = createProject({
      ...POLYFILL_FIXTURE,
      "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      "base.json": tsconfig({ verbatimModuleSyntax: true }),
    });

    const emitted = emit(root, "./main.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(
      /import\s*\{\s*installed\s*\}\s*from\s*["']\.\/polyfill\.ts["']/,
    );

    const ran = runWithHooks(root, "./main.ts");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("polyfill.ts evaluated");
  });

  test("a bare side-effect import is kept under both settings", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json": tsconfig(compilerOptions),
      "side.ts": `console.log("side.ts evaluated");
`,
      "main.ts": `import "./side.ts";
console.log("main.ts");
`,
    });

    for (const compilerOptions of [{ verbatimModuleSyntax: true }, {}]) {
      const root = createProject(files(compilerOptions));
      const emitted = emit(root, "./main.ts");
      expect(emitted.stderr, "dump should not fail").toBe("");
      expect(emitted.stdout).toMatch(/import\s*["']\.\/side\.ts["']/);

      const ran = runWithHooks(root, "./main.ts");
      expect(ran.status).toBe(0);
      expect(ran.stdout).toContain("side.ts evaluated");
    }
  });

  // `tsc` with `verbatimModuleSyntax` emits type-referring export specifiers verbatim
  // (the source is rejected anyway: TS1205/1283-1285), while oxc drops them regardless
  // of the flag. Lock in oxc's identical output under both settings so the known
  // divergence is documented rather than asserted as parity.
  test("a type-referring `export { T }` emits identically with and without the flag", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "tsconfig.json": tsconfig(compilerOptions),
      "main.ts": `type T = number;
export { T };
export const y = 1;
`,
    });

    const on = emit(createProject(files({ verbatimModuleSyntax: true })), "./main.ts");
    const off = emit(createProject(files({})), "./main.ts");
    expect(on.stderr, "dump should not fail").toBe("");
    expect(off.stderr, "dump should not fail").toBe("");
    expect(on.stdout, "the flag must not change type-referring export emit").toBe(off.stdout);
    expect(on.stdout).not.toMatch(/export\s*\{[^}]*\bT\b/);
  });

  // Emit-only: `import =` runs through the CommonJS-targeted transform API, which
  // lowers it to `require(...)`; under the flag the unused binding becomes a live
  // `require`, matching tsc's `shouldEmitAliasDeclaration`.
  test("an unused `import =` stays a live `require()` under the flag", () => {
    const files = (compilerOptions: Record<string, unknown>) => ({
      "tsconfig.json": tsconfig(compilerOptions),
      "dep.ts": `const dep = 1;
export = dep;
`,
      "main.ts": `import foo = require("./dep.ts");
console.log("main.ts");
`,
    });

    const kept = emit(createProject(files({ verbatimModuleSyntax: true })), "./main.ts");
    expect(kept.stderr, "dump should not fail").toBe("");
    expect(kept.stdout).toMatch(/require\(["']\.\/dep\.ts["']\)/);

    const removed = emit(createProject(files({})), "./main.ts");
    expect(removed.stderr, "dump should not fail").toBe("");
    expect(removed.stdout).not.toContain("dep.ts");
  });

  // The load-hook counterpart of the case above: verbatim preservation must surface
  // `import =` in an ES module as a transform error (TS1202, matching `tsc` and Node's
  // own type stripping), never as a `ReferenceError: require is not defined` at run
  // time — which is what keeping the lowered `require()` verbatim produced before.
  test("an `import =` kept verbatim in an ES module fails at load, not at run time", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "tsconfig.json": tsconfig({ verbatimModuleSyntax: true }),
      "dep.ts": `const dep = 1;
export = dep;
`,
      "main.ts": `import foo = require("./dep.ts");
console.log("main.ts");
`,
    });

    const ran = runWithHooks(root, "./main.ts");
    expect(ran.status).not.toBe(0);
    expect(ran.stderr, "the failure must be the TS1202 transform error").toContain(
      "Import assignment cannot be used when targeting ECMAScript modules",
    );
    expect(ran.stderr).not.toContain("require is not defined");
  });
});
