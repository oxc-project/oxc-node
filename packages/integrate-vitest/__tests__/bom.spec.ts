import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * A hashbang is only one at the very start of the source, and the parser takes a
 * byte order mark for whitespace, so a file saved with a BOM before its `#!`
 * failed with `Invalid Character '!'`. Node.js drops the mark before compiling,
 * and so does oxc-node now (issue #846).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const BOM = "\uFEFF";
const HASHBANG = "#!/usr/bin/env node\n";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(type: "module" | "commonjs", files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-bom-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type }));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
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

function run(root: string, entry: string) {
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const typed = (label: string) =>
  `const label: string = ${JSON.stringify(label)};\nconsole.log(label);\n`;

describe("a byte order mark before a hashbang", () => {
  test.each(["main.ts", "main.mts", "main.js", "main.mjs"])("an ES module entry, %s", (entry) => {
    const source = entry.endsWith("js") ? `console.log(${JSON.stringify(entry)});\n` : typed(entry);
    const root = fixture("module", { [entry]: BOM + HASHBANG + source });
    expect(run(root, `./${entry}`)).toBe(`${entry}\n`);
  });

  test.each(["main.ts", "main.cts"])("a CommonJS entry, %s", (entry) => {
    const root = fixture("commonjs", { [entry]: BOM + HASHBANG + typed(entry) });
    expect(run(root, `./${entry}`)).toBe(`${entry}\n`);
  });

  test("a TypeScript file loaded with require()", () => {
    const root = fixture("commonjs", {
      "dep.ts": `${BOM}${HASHBANG}const v: string = "dep";\nexports.v = v;\n`,
      "main.cjs": 'console.log(require("./dep.ts").v);\n',
    });
    expect(run(root, "./main.cjs")).toBe("dep\n");
  });

  test("a BOM alone still loads", () => {
    const root = fixture("module", { "main.ts": BOM + typed("bom") });
    expect(run(root, "./main.ts")).toBe("bom\n");
  });

  // The mark is not part of the program Node.js compiles, so line and column
  // numbers count from after it, as they do for the same file without it.
  test("stack traces point at the same line as without the mark", () => {
    const source = `${HASHBANG}const e: Error = new Error("here");\nconsole.log(e.stack!.split("\\n")[1]);\n`;
    const root = fixture("module", { "with.ts": BOM + source, "without.ts": source });
    const at = (entry: string) => run(root, `./${entry}`).replace(entry, "<entry>");
    expect(at("with.ts")).toBe(at("without.ts"));
    expect(at("with.ts")).toContain("<entry>:2:");
  });
});
