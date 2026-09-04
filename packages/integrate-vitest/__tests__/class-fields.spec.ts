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
 * | `target`   | `useDefineForClassFields` | semantics   |
 * | ---------- | ------------------------- | ----------- |
 * | ES2022+    | unset                     | `[[Define]]` |
 * | below      | unset                     | `[[Set]]`    |
 * | any        | `true`                    | `[[Define]]` |
 * | any        | `false`                   | `[[Set]]`    |
 *
 * TypeScript defaults the option to `true` from `ES2022` — the first target with native
 * class fields — and `tsc` defaults `target` itself to `ES5`, so a project that sets
 * neither gets `[[Set]]`.
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
 * A fixture whose entry point reports whether the field assignment reached the setter
 * inherited from the base class, which only happens with `[[Set]]` semantics.
 */
function fixture(compilerOptions: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-class-fields-"));
  roots.push(root);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions }),
    "entry.ts": [
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
    ].join("\n"),
  };
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

function semanticsOf(compilerOptions: Record<string, unknown>): string {
  const root = fixture(compilerOptions);
  const result = spawnSync(process.execPath, ["--import", REGISTER, "./entry.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined },
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
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

  test("no target at all matches tsc's ES5 default", () => {
    expect(semanticsOf({ module: "ESNext" })).toBe("set");
  });
});
