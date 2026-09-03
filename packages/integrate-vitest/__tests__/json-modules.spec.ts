import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * JSON modules go through oxc-node's own resolver, so tsconfig `paths`, package `exports`
 * and conditions apply to them like they do to every other specifier. The format is decided
 * from the resolved path afterwards: `json` when the caller wrote an import attribute, and
 * `module` otherwise so the load hook can synthesise a default export plus one named export
 * per key.
 */

const REGISTER = fileURLToPath(new URL("../../core/register.mjs", import.meta.url));
const CORE = dirname(REGISTER);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-json-"));
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

/** Run the entry point and return the value it reported as `value: <value>`. */
function reported(root: string, entry: string): string {
  const result = spawnSync(process.execPath, ["--import", REGISTER, entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined },
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, output).toBe(0);
  const match = /^value: (.*)$/m.exec(output);
  expect(match, `expected the entry point to report a value in:\n${output}`).toBeTruthy();
  return match![1]!.trim();
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    baseUrl: ".",
    resolveJsonModule: true,
    paths: { "@data/*": ["./src/*"] },
  },
});

describe("JSON modules and tsconfig paths", () => {
  const aliased = (entry: string) =>
    fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "tsconfig.json": TSCONFIG,
      "src/data.json": JSON.stringify({ v: "aliased" }),
      "entry.ts": entry,
    });

  test("a paths alias resolves with an import attribute", () => {
    const root = aliased(
      [
        'import data from "@data/data.json" with { type: "json" };',
        'console.log("value:", data.v);',
      ].join("\n"),
    );
    expect(reported(root, "./entry.ts")).toBe("aliased");
  });

  test("a paths alias resolves without an import attribute", () => {
    const root = aliased(
      ['import data from "@data/data.json";', 'console.log("value:", data.v);'].join("\n"),
    );
    expect(reported(root, "./entry.ts")).toBe("aliased");
  });

  test("a paths alias keeps the synthesised named exports", () => {
    const root = aliased(
      ['import { v } from "@data/data.json";', 'console.log("value:", v);'].join("\n"),
    );
    expect(reported(root, "./entry.ts")).toBe("aliased");
  });

  test("a paths alias resolves through a dynamic import", () => {
    const root = aliased(
      [
        'const data = await import("@data/data.json");',
        'console.log("value:", data.default.v);',
      ].join("\n"),
    );
    expect(reported(root, "./entry.ts")).toBe("aliased");
  });

  test("an `exports` subpath resolves", () => {
    const root = fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "tsconfig.json": TSCONFIG,
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        version: "1.0.0",
        exports: { "./config": "./cfg/real.json" },
      }),
      "node_modules/pkg/cfg/real.json": JSON.stringify({ v: "exported" }),
      "entry.ts": ['import data from "pkg/config";', 'console.log("value:", data.v);'].join("\n"),
    });
    expect(reported(root, "./entry.ts")).toBe("exported");
  });
});

describe("JSON modules keep working", () => {
  const relative = (entry: string, json = JSON.stringify({ v: "relative" })) =>
    fixture({
      "package.json": JSON.stringify({ name: "fx", private: true, type: "module" }),
      "tsconfig.json": TSCONFIG,
      "data.json": json,
      "entry.ts": entry,
    });

  test.each([
    ["a default import", 'import data from "./data.json";\nconsole.log("value:", data.v);'],
    ["a named import", 'import { v } from "./data.json";\nconsole.log("value:", v);'],
    [
      "an import attribute",
      'import data from "./data.json" with { type: "json" };\nconsole.log("value:", data.v);',
    ],
    [
      "a dynamic import",
      'const data = await import("./data.json");\nconsole.log("value:", data.default.v);',
    ],
    [
      "a query string",
      'const data = await import("./data.json?v=1");\nconsole.log("value:", data.default.v);',
    ],
    [
      "a fragment",
      'const data = await import("./data.json#frag");\nconsole.log("value:", data.default.v);',
    ],
  ])("%s", (_name, entry) => {
    expect(reported(relative(entry), "./entry.ts")).toBe("relative");
  });

  // An array or a scalar has no keys to turn into named exports.
  test.each([
    ["an array", '["one","two"]', "2"],
    ["a number", "42", "42"],
    ["a string", '"text"', "text"],
  ])("%s still has a default export", (_name, json, expected) => {
    const root = relative(
      [
        'import data from "./data.json";',
        'console.log("value:", Array.isArray(data) ? data.length : data);',
      ].join("\n"),
      json,
    );
    expect(reported(root, "./entry.ts")).toBe(expected);
  });
});
