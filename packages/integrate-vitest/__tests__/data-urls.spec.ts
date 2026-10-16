import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";

/**
 * The resolve hook used to short-circuit `data:` URLs with the format `builtin`,
 * so Node.js looked them up as built-in modules and every import failed with
 * `ERR_UNKNOWN_BUILTIN_MODULE` (issue #841). Node.js' own format, derived from the
 * MIME type, is kept now.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-data-urls-"));
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

test("data: URL imports load with the format of their MIME type", () => {
  const base64 = Buffer.from("export default 3").toString("base64");
  const root = fixture({
    "main.ts": [
      "import { v as s } from 'data:text/javascript,export const v = 9';",
      "const m = await import('data:text/javascript,export const v = 7');",
      `const b = await import('data:text/javascript;base64,${base64}');`,
      `const j = await import('data:application/json,{"a":1}', { with: { type: 'json' } });`,
      "let plain: string;",
      "try { await import('data:text/plain,hi'); plain = 'loaded'; } catch (error) { plain = (error as { code: string }).code; }",
      "console.log(s, m.v, b.default, j.default.a, plain);",
    ].join("\n"),
  });
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "./main.ts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: undefined, OXC_LOG: undefined },
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  // `text/plain` has no module format, in plain Node.js too.
  expect(result.stdout).toBe("9 7 3 1 ERR_UNKNOWN_MODULE_FORMAT\n");
});
