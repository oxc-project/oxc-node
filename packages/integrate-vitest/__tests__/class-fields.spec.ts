import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * `useDefineForClassFields` decides whether a public class field is installed with
 * `[[Define]]` semantics (`Object.defineProperty`, the native ES2022 behaviour) or with
 * `[[Set]]` semantics (a plain assignment, which triggers an inherited setter).
 *
 * The difference is observable, so these specs pin oxc-node to what `tsc` does:
 *
 * | `target`   | `useDefineForClassFields` | semantics    |
 * | ---------- | ------------------------- | ------------ |
 * | ES2022+    | unset                     | `[[Define]]` |
 * | below      | unset                     | `[[Set]]`    |
 * | unset      | unset                     | `[[Define]]` |
 * | any        | `true`                    | `[[Define]]` |
 * | any        | `false`                   | `[[Set]]`    |
 *
 * TypeScript defaults the option to `true` from `ES2022` — the first target with native
 * class fields. An unset `target` means `[[Define]]` too: since TypeScript 6, `tsc`
 * defaults `target` to the stable ECMAScript version preceding `ESNext` (before that it
 * defaulted to `ES5`, which meant `[[Set]]`).
 *
 * With `[[Set]]` semantics `tsc` additionally drops fields that have no initializer
 * instead of assigning `undefined` through the prototype chain, and it still runs the
 * decorators of such fields. Both are pinned below.
 */

const REGISTER = fileURLToPath(new URL("../../core/register.mjs", import.meta.url));
const CORE = dirname(REGISTER);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * The default fixture entry point reports whether the field assignment reached the
 * setter inherited from the base class, which only happens with `[[Set]]` semantics.
 */
const SETTER_PROBE = [
  "class Base {",
  "  set field(value: unknown) {",
  "    (this as Record<string, unknown>).setterCalled = true;",
  "  }",
  "}",
  "class Derived extends Base {",
  "  field = 1;",
  "}",
  "const instance = new Derived() as unknown as Record<string, unknown>;",
  'export const semantics = instance.setterCalled === true ? "set" : "define";',
  'console.log("semantics:", semantics);',
].join("\n");

/** A fixture whose entry point is compiled and run under the given compiler options. */
function fixture(compilerOptions: Record<string, unknown> | null, entry = SETTER_PROBE): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-class-fields-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
    "entry.ts": entry,
  };
  if (compilerOptions !== null) {
    files["tsconfig.json"] = JSON.stringify({ compilerOptions });
  }
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  // Lowered class fields import a helper from `@oxc-node/core`.
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(
    CORE,
    join(root, "node_modules", "@oxc-node", "core"),
    // `junction` is the only link type Windows allows without elevated privileges.
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

function run(compilerOptions: Record<string, unknown> | null, entry?: string): string {
  const root = fixture(compilerOptions, entry);
  // A bare specifier, resolved from the fixture's node_modules: on Windows an absolute
  // path is rejected by the ESM loader unless it is a valid file:// URL.
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "./entry.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: undefined },
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  return output;
}

function semanticsOf(compilerOptions: Record<string, unknown> | null): string {
  const output = run(compilerOptions);
  const match = /^semantics: (define|set)$/m.exec(output);
  expect(match, `expected the fixture to report its semantics in:\n${output}`).toBeTruthy();
  return match![1]!;
}

describe("useDefineForClassFields", () => {
  test.each([
    ["ES2022", true],
    ["ESNext", true],
    ["ES2017", false],
    ["ES5", false],
  ])("target %s alone implies %s", (target, expectsDefine) => {
    expect(semanticsOf({ target, module: "ESNext" })).toBe(expectsDefine ? "define" : "set");
  });

  test.each(["ES2022", "ESNext", "ES2017", "ES5"])(
    "an explicit true wins over target %s",
    (target) => {
      expect(semanticsOf({ target, module: "ESNext", useDefineForClassFields: true })).toBe(
        "define",
      );
    },
  );

  test.each(["ES2022", "ESNext", "ES2017", "ES5"])(
    "an explicit false wins over target %s",
    (target) => {
      expect(semanticsOf({ target, module: "ESNext", useDefineForClassFields: false })).toBe("set");
    },
  );

  test("no target at all defaults to the pre-ESNext stable target, like tsc", () => {
    expect(semanticsOf({ module: "ESNext" })).toBe("define");
  });

  test("no tsconfig at all also means define semantics", () => {
    expect(semanticsOf(null)).toBe("define");
  });
});

describe("class fields without an initializer", () => {
  // An uninitialized field is where the two semantics differ beyond the setter: `tsc`
  // either drops the field (`[[Set]]`) or defines it as `undefined` (`[[Define]]`).
  const NO_INITIALIZER_PROBE = [
    "class Base {",
    "  setterCalled?: boolean;",
    "  set field(value: unknown) {",
    "    this.setterCalled = true;",
    "  }",
    "}",
    "class Derived extends Base {",
    "  field: any;",
    "}",
    "const instance = new Derived() as any;",
    'console.log("setterCalled:", instance.setterCalled === true, "own:", Object.prototype.hasOwnProperty.call(instance, "field"));',
    "export {};",
  ].join("\n");

  test("[[Set]] drops the field instead of assigning undefined through the setter", () => {
    const output = run(
      { target: "ES2017", module: "ESNext", useDefineForClassFields: false },
      NO_INITIALIZER_PROBE,
    );
    expect(output).toContain("setterCalled: false own: false");
  });

  test("[[Define]] installs the field as undefined without touching the setter", () => {
    const output = run(
      { target: "ES2017", module: "ESNext", useDefineForClassFields: true },
      NO_INITIALIZER_PROBE,
    );
    expect(output).toContain("setterCalled: false own: true");
  });

  test("a dropped field still runs its legacy decorator", () => {
    const output = run(
      {
        target: "ES2017",
        module: "ESNext",
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
      [
        "const seen: string[] = [];",
        "function dec(target: any, key: string) {",
        "  seen.push(key);",
        "}",
        "class Foo {",
        "  @dec field?: any;",
        "}",
        "new Foo();",
        'console.log("decorated:", seen.join(","));',
        "export {};",
      ].join("\n"),
    );
    expect(output).toContain("decorated: field");
  });
});

describe("#private fields", () => {
  // `tsc` keeps `#private` fields private under both semantics — downleveling them with a
  // WeakMap when needed. They must never become string-keyed own properties, which would
  // leak their names and values and freeze them with `Object.freeze`.
  const PRIVATE_PROBE = [
    "class Counter {",
    "  #secret = 42;",
    "  inc() {",
    "    this.#secret += 1;",
    "  }",
    "  peek() {",
    "    return this.#secret;",
    "  }",
    "}",
    "const counter = new Counter();",
    "Object.freeze(counter);",
    "try {",
    "  counter.inc();",
    "} catch {",
    "  // Mutating a real private field survives freezing; a string-keyed one throws.",
    "}",
    'console.log("own:", Object.getOwnPropertyNames(counter).length, "value:", counter.peek());',
    "export {};",
  ].join("\n");

  test.each([false, true])(
    "stay private and unfrozen with useDefineForClassFields: %s",
    (value) => {
      const output = run(
        { target: "ES2017", module: "ESNext", useDefineForClassFields: value },
        PRIVATE_PROBE,
      );
      expect(output).toContain("own: 0 value: 43");
    },
  );
});
