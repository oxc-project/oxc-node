import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

/**
 * Node.js decodes module source as UTF-8 and replaces every invalid byte sequence
 * with U+FFFD. oxc-node decoded strictly and failed every such file with
 * `Failed to convert Uint8Array to Vec<u8>`, naming neither the file nor the
 * problem (issue #843).
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, Buffer | string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-invalid-utf8-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
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

// `"caf` + a lone 0xE9 byte (latin-1 `é`, not valid UTF-8) + `"`.
const cafe = (before: string, after: string) =>
  Buffer.concat([Buffer.from(`${before}"caf`), Buffer.from([0xe9]), Buffer.from(`"${after}`)]);

test("source that is not valid UTF-8 decodes as Node.js decodes it", () => {
  const root = fixture({
    "main.ts": cafe(
      "const s: string = ",
      ";\nconsole.log('ts', s.length, s.codePointAt(3)!.toString(16));\n",
    ),
    "dep.mts": cafe("export const s: string = ", ";\n"),
    "dep.cts": cafe("exports.s = ", ";\n"),
    "data.json": cafe('{"s": ', "}\n"),
    "entry.ts": [
      "import './main.ts';",
      "import { s } from './dep.mts';",
      "import { createRequire } from 'node:module';",
      "import data from './data.json' with { type: 'json' };",
      "const cjs = createRequire(import.meta.url)('./dep.cts');",
      "console.log('mts', s.length, 'cts', cjs.s.length, 'json', data.s.length);",
    ].join("\n"),
  });
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "./entry.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
      timeout: 30_000,
    },
  );
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("ts 4 fffd\nmts 4 cts 4 json 4\n");
});
