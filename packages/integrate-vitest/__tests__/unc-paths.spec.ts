import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Windows UNC paths — `\\server\share\…` — round trip through `file:` URLs
 * with the server name in the authority: `file://server/share/…`, the form
 * `pathToFileURL` produces (issue #744). Before the fix the loader read the
 * authority as a path segment, so a UNC parent failed resolution outright
 * ("Parent URL is not a file URL") and a resolved UNC path was reported back
 * as `file://///server/…`, which Node.js reads as a different path.
 *
 * A drive-letter fixture cannot catch this — `file:///C:/…` matches the old
 * prefix in both directions — so these specs stand up a real share: a
 * directory is shared on the runner itself (`net share`) and reached through
 * `\\%COMPUTERNAME%\<share>`. Everything is skipped when the share cannot be
 * created (no admin rights, Server service stopped), which is the only reason
 * these specs exist on a best-effort basis.
 */

const SHARE = "OXCNODEUNC";

const REGISTER = fileURLToPath(new URL("../../core/register.mjs", import.meta.url));

const isWindows = process.platform === "win32";

// Set up the loopback share before collecting tests, so `describe.skipIf`
// below sees the real answer.
let fixtureDir = "";
let uncRoot = "";
let shareReady = false;

if (isWindows) {
  fixtureDir = mkdtempSync(join(tmpdir(), "oxc-node-unc-"));
  uncRoot = `\\\\${process.env.COMPUTERNAME}\\${SHARE}`;
  const created = spawnSync("net", ["share", `${SHARE}=${fixtureDir}`, "/grant:Everyone,FULL"], {
    encoding: "utf8",
  });
  shareReady = created.status === 0 && existsSync(uncRoot);
}

afterAll(() => {
  if (shareReady) {
    spawnSync("net", ["share", SHARE, "/delete", "/yes"], { encoding: "utf8" });
  }
  if (fixtureDir) {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

function fixture(name: string, contents: string): void {
  // No share, no fixture: the describe body below still runs at collection
  // time when the specs are skipped, and must not touch the filesystem then.
  if (!fixtureDir) {
    return;
  }
  const path = join(fixtureDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Run a node process with the oxc-node loader registered, returning its combined output. */
function run(entry: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--import", REGISTER, entry], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      // An explicit tsconfig from the environment wins over the fixture's own
      // tsconfig.json and would silently rewrite what is being asserted.
      TS_NODE_PROJECT: undefined,
      OXC_TSCONFIG_PATH: undefined,
    },
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  return { status: result.status, output };
}

describe.skipIf(!shareReady)("Windows UNC file URLs", () => {
  fixture("package.json", JSON.stringify({ name: "unc-fixture", private: true, type: "module" }));
  fixture(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "es2023",
        module: "ESNext",
        useDefineForClassFields: false,
      },
    }),
  );
  // The setter probe doubles as a tsconfig-discovery probe: only the
  // fixture's own config asks for `[[Set]]` semantics, so "setter called"
  // proves the config was found and applied through the UNC path.
  fixture(
    "lib.ts",
    [
      "class Base {",
      "  log = 'setter NOT called';",
      "  set x(v: string) { this.log = `setter called with ${v}`; }",
      "  get x(): string { return this.log; }",
      "}",
      "class Sub extends Base { x = 'assigned'; }",
      'console.log("unc-lib:", new Sub().log);',
    ].join("\n"),
  );
  fixture("helper.ts", ['export const marker: string = "unc-helper";', ""].join("\n"));
  fixture(
    "lib2.ts",
    ['import { marker } from "./helper.ts";', 'console.log("unc-lib2:", marker);'].join("\n"),
  );
  fixture(
    "entry-url.mjs",
    [`await import("file://${process.env.COMPUTERNAME}/${SHARE}/lib.ts");`].join("\n"),
  );
  fixture(
    "entry-relative.mjs",
    [`await import("file://${process.env.COMPUTERNAME}/${SHARE}/lib2.ts");`].join("\n"),
  );
  fixture(
    "entry-cli.ts",
    ['const msg: string = "ok";', 'console.log("unc-cli:", msg);', ""].join("\n"),
  );
  // A literal `%` in a file name must round trip: the generated URL has to
  // carry it as `%25`, or Node decodes it as an escape and loads the wrong
  // file (adversarial-review finding on this branch).
  fixture("pct%20name.ts", ['console.log("unc-pct: ok");', ""].join("\n"));
  fixture(
    "entry-pct.mjs",
    [`await import("file://${process.env.COMPUTERNAME}/${SHARE}/pct%2520name.ts");`].join("\n"),
  );

  test("a UNC file URL imports and runs TypeScript", () => {
    const { status, output } = run("entry-url.mjs");
    expect(output, output).not.toContain("Parent URL is not a file URL");
    expect(status, output).toBe(0);
    // The fixture's tsconfig was discovered through the UNC path.
    expect(output).toContain("unc-lib: setter called with assigned");
  });

  test("relative imports from a UNC parent resolve and load", () => {
    const { status, output } = run("entry-relative.mjs");
    expect(output, output).not.toContain("Parent URL is not a file URL");
    expect(status, output).toBe(0);
    // The resolved helper round trips through `file://<host>/…` generation.
    expect(output).toContain("unc-lib2: unc-helper");
  });

  test("a UNC path CLI entry point runs", () => {
    const { status, output } = run(`${uncRoot}\\entry-cli.ts`);
    expect(output, output).not.toContain("Parent URL is not a file URL");
    expect(status, output).toBe(0);
    expect(output).toContain("unc-cli: ok");
  });

  test("a file name with a literal percent round trips", () => {
    const { status, output } = run("entry-pct.mjs");
    expect(output, output).not.toContain("Parent URL is not a file URL");
    expect(status, output).toBe(0);
    expect(output).toContain("unc-pct: ok");
  });
});
