import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

/**
 * oxc lowers only legacy (`experimentalDecorators`) decorators. No Node.js release parses
 * decorator syntax, so without the option a decorated file used to reach Node.js
 * untouched and fail at the `@` with a bare `SyntaxError: Invalid or unexpected token`
 * (issue #809). The transform now fails with a message that says what to change.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

const EXPECTED_ERROR =
  'decorators require `"experimentalDecorators": true` in tsconfig.json; ' +
  "standard (TC39) decorators are not supported yet";

const DECORATED = [
  "function logged(value: unknown, _context: unknown) {",
  "  return value;",
  "}",
  "@logged",
  "class Service {}",
  'console.log("ran:" + new Service().constructor.name);',
].join("\n");

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function run(files: Record<string, string>, entry: string) {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-decorators-"));
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
  return spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined, DEBUG: undefined },
    timeout: 30_000,
  });
}

test.each([
  ["no tsconfig", {}],
  ["a tsconfig without experimentalDecorators", { "tsconfig.json": "{}" }],
])("a decorator with %s fails with an actionable error", (_, extra) => {
  for (const [entry, pkg] of [
    ["./main.ts", { type: "module" }],
    ["./main.ts", {}],
    ["./main.mts", {}],
    ["./main.cts", {}],
  ] as const) {
    const result = run(
      { ...extra, "package.json": JSON.stringify(pkg), [entry.slice(2)]: DECORATED },
      entry,
    );
    expect(result.status, `${entry} ${JSON.stringify(pkg)}`).not.toBe(0);
    expect(result.stderr, `${entry} ${JSON.stringify(pkg)}`).toContain(EXPECTED_ERROR);
    expect(result.stderr, `${entry} ${JSON.stringify(pkg)}`).not.toContain(
      "Invalid or unexpected token",
    );
  }
});

test("a decorator with experimentalDecorators still runs", () => {
  const result = run(
    {
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
      "main.ts": DECORATED,
    },
    "./main.ts",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("ran:Service");
});

test("an @ outside a decorator does not trip the check", () => {
  const result = run(
    {
      "package.json": JSON.stringify({ type: "module" }),
      "main.ts": '/** @deprecated */\nclass A {}\nconsole.log("ran:" + "a@b".length, A.name);\n',
    },
    "./main.ts",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("ran:3 A");
});

test("a decorator on an ambient declaration is erased with it", () => {
  const result = run(
    {
      "package.json": JSON.stringify({ type: "module" }),
      "main.ts":
        "declare function dec(...args: unknown[]): any;\n" +
        "@dec declare class A { @dec x: string }\n" +
        'console.log("ran:ambient");\n',
    },
    "./main.ts",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("ran:ambient");
});
