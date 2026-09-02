import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * When a transform needs a runtime helper, oxc injects an import of it. Whether that is an
 * `import` declaration or a `require()` call is decided by the module kind of the source,
 * and for `.js`, `.jsx`, `.ts` and `.tsx` oxc infers that from the presence of
 * `import`/`export` syntax — so a file that happens to have none looks like a script.
 *
 * Node.js decides from the nearest `package.json` instead, so such a file inside a
 * `"type": "module"` package is executed as an ES module and the injected `require()` fails
 * with `ReferenceError: require is not defined in ES module scope`. The loader knows the
 * format Node.js reported and passes it down, so these specs cover both module kinds with
 * and without module syntax.
 */

const REGISTER = fileURLToPath(new URL("../../core/register.mjs", import.meta.url));
const CORE = dirname(REGISTER);

/** A transform that always needs a helper: a class field lowered to `[[Define]]`. */
const NEEDS_HELPER = [
  "class Base {",
  "  set field(value) {",
  "    this.setterCalled = true;",
  "  }",
  "}",
  "class Derived extends Base {",
  "  field = 1;",
  "}",
  'const report = () => console.log("field:", new Derived().field);',
];

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-helpers-"));
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
  const result = spawnSync(process.execPath, ["--import", REGISTER, entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined },
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

// `useDefineForClassFields` is what pulls in the helper; the value that does so is the one
// oxc maps to `[[Define]]` semantics.
const TSCONFIG = JSON.stringify({
  compilerOptions: { module: "ESNext", target: "ES2022", useDefineForClassFields: false },
});

describe("injected runtime helpers", () => {
  test.each([
    // A `"type": "module"` package: every extension below is an ES module to Node.js, but
    // only `.mts` says so through its extension.
    ["module", "entry.ts", "no module syntax"],
    ["module", "entry.mts", "no module syntax"],
    ["module", "entry.ts", "with an export"],
    ["commonjs", "entry.ts", "no module syntax"],
    ["commonjs", "entry.cts", "no module syntax"],
  ])("a %s package loading %s (%s)", (type, entry, shape) => {
    const body = [...NEEDS_HELPER];
    if (shape === "with an export") {
      body.push("export const exported = true;");
    }
    body.push("report();");
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type }),
      "tsconfig.json": TSCONFIG,
      [entry]: body.join("\n"),
    });
    expect(run(root, `./${entry}`)).toContain("field: 1");
  });

  test("an imported module without module syntax also gets a usable helper", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "tsconfig.json": TSCONFIG,
      // No `import`/`export`, so oxc would infer a script and inject `require()`.
      "dep.ts": [...NEEDS_HELPER, "globalThis.__report = report;"].join("\n"),
      "entry.ts": ['import "./dep.ts";', "(globalThis as Record<string, any>).__report();"].join(
        "\n",
      ),
    });
    expect(run(root, "./entry.ts")).toContain("field: 1");
  });
});
