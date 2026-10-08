import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * oxc lowers `enum` members to `Foo["X"] = <init>` statements and wraps the init in a
 * reverse mapping `Foo[Foo["X"] = init] = "X"` unless it can prove the init is a
 * string. That proof comes from `SemanticBuilder::with_enum_eval(true)`, which
 * pre-computes member values during semantic analysis. Without it,
 * `enum Theme { Light = "Light", Default = Theme.Light }` emitted
 * `Theme[Theme["Default"] = Theme.Light] = "Default"`, and the reverse mapping
 * overwrote `Theme.Light` with `"Default"` at run time — `Theme.Default` printed
 * `"Light"` but `Theme.Light` printed `"Default"` (issue #795, oxc#21667). With
 * evaluated member values the alias folds to the string literal, gets no reverse
 * mapping, and both keys print `"Light"`.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

// Prints what the transformer emits for one file, so a spec can assert on the output
// itself. The transform API targets CommonJS, but nothing downlevels ESM syntax.
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
  const root = mkdtempSync(join(tmpdir(), "oxc-enum-"));
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

const THEME = `enum Theme {
  Light = "Light",
  Dark = "Dark",
  Default = Theme.Light,
}
console.log(Theme.Light, Theme.Default);
`;

describe("enum member values (issue #795)", () => {
  test("a member aliasing a string member emits no reverse mapping and both keys work", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "theme.ts": THEME,
    });

    const emitted = emit(root, "./theme.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    // The alias folds to the string literal, which is a plain assignment — no
    // `Theme[Theme["Default"] = ...] = "Default"` reverse mapping.
    expect(emitted.stdout).toMatch(/Theme\["Default"\]\s*=\s*["']Light["']/);
    expect(emitted.stdout).not.toMatch(/=\s*["']Default["']/);

    const ran = runWithHooks(root, "./theme.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("Light Light");
  });

  // `--import register` on a CommonJS entry goes through `Module._extensions`, i.e.
  // the `pirates` hook calling `transform` — the same `transform_program` the ESM
  // load hook uses, but worth locking in on the path the issue's reporter hit.
  test("the same alias works in a CommonJS package through register", () => {
    const root = createProject({
      "package.json": '{ "type": "commonjs" }\n',
      "theme.ts": THEME,
    });

    const ran = runWithHooks(root, "./theme.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("Light Light");
  });

  // oxc folds the alias to the literal `1` while `tsc` emits `E.A`; the emitted text
  // differs but the runtime behaviour is identical, so assert behaviour, not parity.
  test("a member aliasing a numeric member folds and auto-increment continues", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "e.ts": `enum E { A = 1, B = A }
console.log(E.A, E.B);
enum F { X = 1, Y = X, Z }
console.log(F.X, F.Y, F.Z);
`,
    });

    const emitted = emit(root, "./e.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/E\[E\["B"\]\s*=\s*1\]/);
    expect(emitted.stdout).toMatch(/F\[F\["Z"\]\s*=\s*2\]/);

    const ran = runWithHooks(root, "./e.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("1 1");
    expect(ran.stdout).toContain("1 1 2");
  });

  test("a string-concatenated member folds and gets no reverse mapping", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "s.ts": `enum S { A = "a", B = A + "!" }
console.log(S.A, S.B);
`,
    });

    const emitted = emit(root, "./s.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/S\["B"\]\s*=\s*["']a!["']/);
    expect(emitted.stdout).not.toMatch(/S\[S\["B"\]/);

    const ran = runWithHooks(root, "./s.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("a a!");
  });

  // `tsc` rejects the forward reference with TS2450; oxc never type-checks, so it
  // emits the reference verbatim and `A` reads `undefined` at run time.
  test("a forward member reference stays a reference and reads undefined", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "e.ts": `enum E { A = B, B = 2 }
console.log(E.A, E.B);
`,
    });

    const emitted = emit(root, "./e.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/E\[E\["A"\]\s*=\s*E\.B\]/);

    const ran = runWithHooks(root, "./e.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("undefined 2");
  });

  // The evaluator declines `'x'.length` (a member expression on a non-identifier),
  // so `A` keeps its runtime initializer and the alias `B` keeps its `E.A`
  // reference — including its reverse mapping, which lands on the number `1`.
  test("a non-constant member keeps its initializer and aliases still resolve", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "e.ts": `enum E { A = "x".length, B = A }
console.log(E.A, E.B);
`,
    });

    const emitted = emit(root, "./e.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/E\[E\["A"\]\s*=\s*["']x["']\.length\]/);
    expect(emitted.stdout).toMatch(/E\[E\["B"\]\s*=\s*E\.A\]/);

    const ran = runWithHooks(root, "./e.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("1 1");
  });

  // `optimize_const_enums` stays off — const enums keep their IIFE like `tsc` under
  // `isolatedModules` and Node's own type stripping — but the alias still folds.
  test("a const enum keeps its IIFE while its alias folds", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "c.ts": `const enum C { A = "a", B = C.A }
console.log(C.A, C.B);
`,
    });

    const emitted = emit(root, "./c.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).toMatch(/var C\s*=/);
    expect(emitted.stdout).toMatch(/C\["B"\]\s*=\s*["']a["']/);
    expect(emitted.stdout).not.toMatch(/C\[C\["B"\]/);

    const ran = runWithHooks(root, "./c.ts");
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("a a");
  });

  // Lock-in: `tsc` emits nothing for `declare enum` but keeps `D.A` as an ambient
  // member access, so it also throws at run time — this matches, and matches Node's
  // type stripping: the declaration is erased and the reference is left dangling.
  test("a declare enum is erased and a member access throws", () => {
    const root = createProject({
      "package.json": '{ "type": "module" }\n',
      "d.ts": `declare enum D { A = 1 }
console.log(D.A);
`,
    });

    const emitted = emit(root, "./d.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout).not.toMatch(/var D\b/);

    const ran = runWithHooks(root, "./d.ts");
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain("D is not defined");
  });
});
