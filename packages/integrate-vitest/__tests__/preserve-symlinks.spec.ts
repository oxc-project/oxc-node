import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Node.js keeps a symlinked module's path under `--preserve-symlinks`, and the
 * entry point's under `--preserve-symlinks-main`; oxc-node's resolver always
 * returned the real path. And `OXC_LOG` wrote its log to stdout, mixed into the
 * program's own output (issue #845).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

// `junction` is the only link type Windows allows without elevated privileges.
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * `node_modules/sym` links to `vendor/sym`, whose module prints where it was
 * loaded from, as does `real/entry.mjs`, which `link.mjs` links to.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-preserve-symlinks-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "vendor/sym/package.json": JSON.stringify({ name: "sym", main: "index.js", type: "module" }),
    "vendor/sym/index.js":
      'export default import.meta.url.includes("/node_modules/sym/") ? "linked" : "real";\n',
    "main.mjs": 'import where from "sym";\nconsole.log("package:" + where);\n',
    "main.ts":
      'import where from "sym";\nconst label: string = "package:";\nconsole.log(label + where);\n',
    "real/entry.mjs":
      'console.log("entry:" + (import.meta.url.endsWith("/link.mjs") ? "linked" : "real"));\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(CORE, join(root, "node_modules", "@oxc-node", "core"), DIR_LINK);
  symlinkSync(join(root, "vendor", "sym"), join(root, "node_modules", "sym"), DIR_LINK);
  if (process.platform !== "win32") {
    symlinkSync(join(root, "real", "entry.mjs"), join(root, "link.mjs"));
  }
  return root;
}

const ENV = {
  ...process.env,
  NODE_OPTIONS: undefined,
  NODE_PRESERVE_SYMLINKS: undefined,
  OXC_LOG: undefined,
  TS_NODE_PROJECT: undefined,
  OXC_TSCONFIG_PATH: undefined,
};

function run(root: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...ENV, ...env },
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  return result;
}

const REGISTER = ["--import", "@oxc-node/core/register"];

describe("symlinks resolve as Node.js resolves them", () => {
  const cases: [string, string[], Record<string, string>][] = [
    ["no flag", [], {}],
    ["--preserve-symlinks", ["--preserve-symlinks"], {}],
    ["--preserve_symlinks", ["--preserve_symlinks"], {}],
    ["a later --no-preserve-symlinks", ["--preserve-symlinks", "--no-preserve-symlinks"], {}],
    ["--preserve-symlinks-main", ["--preserve-symlinks-main"], {}],
    ["NODE_OPTIONS", [], { NODE_OPTIONS: "--preserve-symlinks" }],
    ["NODE_PRESERVE_SYMLINKS=1", [], { NODE_PRESERVE_SYMLINKS: "1" }],
  ];

  test.each(cases)("a symlinked package, with %s", (_, flags, env) => {
    const root = fixture();
    const node = run(root, [...flags, "./main.mjs"], env).stdout;
    expect(run(root, [...flags, ...REGISTER, "./main.mjs"], env).stdout).toBe(node);
  });

  test.skipIf(process.platform === "win32").each(cases)(
    "a symlinked entry point, with %s",
    (_, flags, env) => {
      const root = fixture();
      const node = run(root, [...flags, "./link.mjs"], env).stdout;
      expect(run(root, [...flags, ...REGISTER, "./link.mjs"], env).stdout).toBe(node);
    },
  );

  test("a TypeScript importer keeps the symlinked path under --preserve-symlinks", () => {
    const root = fixture();
    expect(run(root, ["--preserve-symlinks", ...REGISTER, "./main.ts"]).stdout).toBe(
      "package:linked\n",
    );
    expect(run(root, [...REGISTER, "./main.ts"]).stdout).toBe("package:real\n");
  });
});

test("OXC_LOG writes to stderr and leaves stdout to the program", () => {
  const root = fixture();
  const result = run(root, [...REGISTER, "./main.ts"], { OXC_LOG: "debug" });
  expect(result.stdout, "stdout holds only the program's output").toBe("package:real\n");
  expect(result.stderr, "the log goes to stderr").toContain("DEBUG");
});
