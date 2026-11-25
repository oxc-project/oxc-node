import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * oxc lowers only legacy (`experimentalDecorators`) decorators. No Node.js release parses
 * decorator syntax, so without the option a decorated file used to reach Node.js
 * untouched and fail at the `@` with a bare `SyntaxError: Invalid or unexpected token`
 * (issue #809). The transform now fails with a message that says what to change.
 */

const CORE = fileURLToPath(new URL("../../core", import.meta.url));

const EXPECTED_ERROR =
  'decorators require `"experimentalDecorators": true` in a tsconfig.json that includes this file; ' +
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

test("a decorated JavaScript file names allowJs too, and runs once it is set", () => {
  const files = (compilerOptions: Record<string, unknown>) => ({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions }),
    "main.js": DECORATED.replace("(value: unknown, _context: unknown)", "(value)"),
  });

  const rejected = run(files({ experimentalDecorators: true }), "./main.js");
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain(
    'decorators require `"experimentalDecorators": true` and `"allowJs": true` in a tsconfig.json that includes this file',
  );

  const ran = run(files({ experimentalDecorators: true, allowJs: true }), "./main.js");
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout.trim()).toBe("ran:Service");
});

test("a declaration file is erased whole, decorators included", () => {
  const result = run(
    {
      "package.json": JSON.stringify({ type: "module" }),
      "types.d.ts": "declare function dec(...args: unknown[]): any;\nexport @dec class A {}\n",
      "main.ts": 'import "./types.d.ts";\nconsole.log("ran:dts");\n',
    },
    "./main.ts",
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("ran:dts");
});

describe("emitDecoratorMetadata follows strictNullChecks like tsc (issue #927)", () => {
  // `tsc` resolves `strictNullChecks` as `strictNullChecks ?? strict`, and TypeScript 6
  // and later default `strict` to `true`. With null checks on, `T | null` and
  // `T | undefined` are recorded as `Object`; with them off, `null`/`undefined` drop out
  // of the union and `T` itself is recorded. Each row's expectation is what `tsc` 7.0.2
  // emits for that tsconfig. A member's decorators run bottom-up, as `tsc`'s `__decorate`
  // applies them, so a method records `design:returntype` first.
  const ENTRY = [
    "// A stand-in for reflect-metadata: print each value as it is recorded.",
    "(Reflect as any).metadata = (key: string, value: any) => (_target: object, prop: string) => {",
    '  const name = Array.isArray(value) ? `[${value.map((v) => v.name).join(",")}]` : value.name;',
    "  console.log(`${prop} ${key}=${name}`);",
    "};",
    "function Dec(): any {",
    "  return () => {};",
    "}",
    "class Entity {",
    "  @Dec() name: string | null = null;",
    "  @Dec() count: number | undefined;",
    "  @Dec() find(id: string | undefined): string | null {",
    "    return id ?? null;",
    "  }",
    "}",
    "console.log(`ran:${Entity.name}`);",
  ].join("\n");

  const NULLABLE = [
    "name design:type=Object",
    "count design:type=Object",
    "find design:returntype=Object",
    "find design:paramtypes=[Object]",
    "find design:type=Function",
    "ran:Entity",
  ];
  const STRIPPED = [
    "name design:type=String",
    "count design:type=Number",
    "find design:returntype=String",
    "find design:paramtypes=[String]",
    "find design:type=Function",
    "ran:Entity",
  ];

  const DECORATORS = { experimentalDecorators: true, emitDecoratorMetadata: true };

  test.each([
    ["strict alone", { strict: true }, {}, NULLABLE],
    ["strict with strictNullChecks", { strict: true, strictNullChecks: true }, {}, NULLABLE],
    ["neither flag (TypeScript 6+ defaults strict to true)", {}, {}, NULLABLE],
    ["strict: false", { strict: false }, {}, STRIPPED],
    [
      "strictNullChecks: false over strict",
      { strict: true, strictNullChecks: false },
      {},
      STRIPPED,
    ],
    [
      "strictNullChecks over strict: false",
      { strict: false, strictNullChecks: true },
      {},
      NULLABLE,
    ],
    [
      "a child strictNullChecks: false over a base strict",
      { strictNullChecks: false },
      { strict: true },
      STRIPPED,
    ],
    [
      "a base strictNullChecks: false over a child strict",
      { strict: true },
      { strictNullChecks: false },
      STRIPPED,
    ],
    ["strict: false inherited from a base", {}, { strict: false }, STRIPPED],
  ] as const)("%s", (_, compilerOptions, baseCompilerOptions, expected) => {
    const extendsBase = Object.keys(baseCompilerOptions).length > 0;
    const result = run(
      {
        "package.json": JSON.stringify({ type: "module" }),
        ...(extendsBase && {
          "tsconfig.base.json": JSON.stringify({ compilerOptions: baseCompilerOptions }),
        }),
        "tsconfig.json": JSON.stringify({
          ...(extendsBase && { extends: "./tsconfig.base.json" }),
          compilerOptions: { ...DECORATORS, ...compilerOptions },
        }),
        "main.ts": ENTRY,
      },
      "./main.ts",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(expected);
  });
});
