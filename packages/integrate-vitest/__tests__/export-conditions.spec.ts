import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Every resolve request carries its own export conditions. The resolver used to
 * be created once, with the conditions of whichever caller got there first: a
 * `require()` of a TypeScript file initialised it with none, so a later
 * `import()` picked a package's `default` branch over `import` (issue #810).
 */

const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-conditions-"));
  roots.push(root);
  const files: Record<string, string> = {
    "node_modules/cond-pkg/package.json": JSON.stringify({
      name: "cond-pkg",
      exports: { import: "./esm.mjs", require: "./require.cjs", default: "./default.cjs" },
    }),
    "node_modules/cond-pkg/esm.mjs": "export const flavor = 'import';\n",
    "node_modules/cond-pkg/require.cjs": "exports.flavor = 'require';\n",
    "node_modules/cond-pkg/default.cjs": "exports.flavor = 'default';\n",
    "first.ts": "export const first: string = 'first.ts';\n",
  };
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

function run(root: string, script: string): string {
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "-e", script],
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
  return result.stdout.trim();
}

describe("export conditions", () => {
  test("import() picks the import condition", () => {
    const root = fixture();
    expect(run(root, "import('cond-pkg').then((m) => console.log(m.flavor))")).toBe("import");
  });

  test("import() picks the import condition after a require() of a TypeScript file", () => {
    const root = fixture();
    expect(
      run(root, "require('./first.ts'); import('cond-pkg').then((m) => console.log(m.flavor))"),
    ).toBe("import");
  });

  test("require() picks the require condition after an import()", () => {
    const root = fixture();
    expect(
      run(root, "import('cond-pkg').then(() => console.log(require('cond-pkg').flavor))"),
    ).toBe("require");
  });
});
