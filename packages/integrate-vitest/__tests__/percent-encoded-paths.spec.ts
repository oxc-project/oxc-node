import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Node hands the resolve hook percent-encoded URLs (`main%23hash.ts`), the
 * resolver finds `main#hash.ts`, and the hook used to turn that path back into
 * a URL without encoding it. Node then read the raw `#` as a fragment and `%41`
 * as an escape, so a different file ran — with exit code 0 — or the module was
 * not found at all (issue #837). Every target prints `OK`, every decoy
 * `WRONG_FILE`, and the assertions check the output rather than the exit code.
 *
 * The fixtures are written at run time: `#` and `%` file names are awkward to
 * commit and check out.
 */

const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-node-encoded-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
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

const ENV = {
  ...process.env,
  NODE_OPTIONS: undefined,
  OXC_LOG: undefined,
  TS_NODE_PROJECT: undefined,
  OXC_TSCONFIG_PATH: undefined,
};

function run(root: string, entry: string): string {
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry], {
    cwd: root,
    encoding: "utf8",
    env: ENV,
    timeout: 30_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.error, result.error?.message).toBeFalsy();
  expect(output).not.toContain("WRONG_FILE");
  expect(result.status, output).toBe(0);
  return result.stdout;
}

// `import.meta.url` is typed so the TypeScript transform runs on every target.
const OK = 'const url: string = import.meta.url;\nconsole.log("OK", url);\n';
const WRONG = 'console.log("WRONG_FILE");\n';

// Node's own URL for the file. macOS `tmpdir()` sits behind the `/var` ->
// `/private/var` symlink, and Node reports the real path.
const urlOf = (root: string, name: string) => pathToFileURL(realpathSync(join(root, name))).href;

const isWindows = process.platform === "win32";

describe("percent-encoded resolved URLs (issue #837)", () => {
  test.each([
    // Each decoy is the file the unencoded URL used to name.
    { target: "main#hash.ts", decoy: "main" },
    { target: "main%41.ts", decoy: "mainA.ts" },
    { target: "main%file.ts" },
    { target: "only#hash.ts" },
    { target: "hash#dir/main.ts", decoy: "hash" },
    { target: "a%41/main.ts", decoy: "aA/main.ts" },
    { target: "main space õ.ts" },
    // `?` is not a legal Windows file-name character.
    ...(isWindows ? [] : [{ target: "main?q.ts", decoy: "main" }]),
  ])("the entry point $target runs", ({ target, decoy }: { target: string; decoy?: string }) => {
    const root = fixture({ [target]: OK, ...(decoy ? { [decoy]: WRONG } : {}) });
    const stdout = run(root, `./${target}`);
    expect(stdout).toBe(`OK ${urlOf(root, target)}\n`);
  });

  test("relative imports from inside a # directory resolve", () => {
    const root = fixture({
      "a#b/main.ts":
        'import { v } from "./dep.ts";\nimport data from "./data.json";\nconsole.log("OK", v, data.v);\n',
      "a#b/dep.ts": "export const v: number = 1;\n",
      "a#b/data.json": '{ "v": 2 }',
      a: WRONG,
    });
    expect(run(root, "./a#b/main.ts")).toBe("OK 1 2\n");
  });

  test("encoded relative and absolute imports name the decoded file", () => {
    const root = fixture({
      "entry.ts": [
        'await import("./dir%23x/main.ts");',
        'await import("./main%2541.ts");',
        // A file literally named `main%23hash.ts` is not what `%23` means.
        'await import("./main%23hash.ts");',
        // The query is module identity and stays raw after the encoded path.
        'await import(new URL("./main%23hash.ts?v=1", import.meta.url).href);',
        'const { default: data } = await import("./data%231.json", { with: { type: "json" } });',
        'console.log("JSON", data.v);',
      ].join("\n"),
      "dir#x/main.ts": OK,
      dir: WRONG,
      "main%41.ts": OK,
      "mainA.ts": WRONG,
      "main#hash.ts": OK,
      "main%23hash.ts": WRONG,
      main: WRONG,
      "data#1.json": '{ "v": 3 }',
    });
    expect(run(root, "./entry.ts").split("\n")).toEqual([
      `OK ${urlOf(root, "dir#x/main.ts")}`,
      `OK ${urlOf(root, "main%41.ts")}`,
      `OK ${urlOf(root, "main#hash.ts")}`,
      `OK ${urlOf(root, "main#hash.ts")}?v=1`,
      "JSON 3",
      "",
    ]);
  });

  test("encoded separators are left to Node, which rejects them", () => {
    // Decoding `%2F` / `%5C` into a separator would load `a/b.ts`; Node
    // refuses the specifier instead.
    const root = fixture({
      "entry.ts": [
        'for (const s of ["./a%2Fb.ts", "./a%2fb.ts", "./a%5Cb.ts", "./a%2Fb", new URL("./a%2Fb.ts", import.meta.url).href]) {',
        "  try { await import(s); } catch (error) { console.log((error as { code: string }).code); }",
        "}",
      ].join("\n"),
      "a/b.ts": WRONG,
    });
    expect(run(root, "./entry.ts")).toBe("ERR_INVALID_MODULE_SPECIFIER\n".repeat(5));
  });

  test("malformed escapes are left to Node, which rejects them", () => {
    // `%zz` is not an escape and `%FF` does not decode to UTF-8; resolving
    // either spelling verbatim would load the literally named file.
    const root = fixture({
      "entry.ts": [
        'for (const s of ["./a%FF.ts", "./b%zz.ts", new URL("./b%zz.ts", import.meta.url).href]) {',
        "  try { await import(s); } catch (error) { console.log((error as Error).name); }",
        "}",
      ].join("\n"),
      "a%FF.ts": WRONG,
      "b%zz.ts": WRONG,
    });
    expect(run(root, "./entry.ts")).toBe("URIError\n".repeat(3));
  });

  test.skipIf(isWindows)("network-path references are left to Node", () => {
    // `//tmp/…/a%20b.ts` names the host `tmp`, which Node refuses; decoding
    // it as a path would load the local `a b.ts`.
    const root = realpathSync(fixture({ "a b.ts": WRONG }));
    writeFileSync(
      join(root, "entry.ts"),
      `try { await import(${JSON.stringify(`/${root}/a%20b.ts`)}); } catch (error) { console.log((error as { code: string }).code); }\n`,
    );
    expect(run(root, "./entry.ts")).toBe("ERR_INVALID_FILE_URL_HOST\n");
  });

  // `\` is not a legal Windows file-name character, and is a separator there.
  test.skipIf(isWindows)("a backslash in a specifier is a separator, as in Node", () => {
    // The URL parser reads `\` as `/`; the resolver would pick the file
    // literally named `dir\foo bar.ts`, whose URL Node then rejects.
    const root = fixture({
      "dir/foo bar.ts": OK,
      "dir\\foo bar.ts": WRONG,
      "dir/plain.ts": OK,
      "dir\\plain.ts": WRONG,
      "entry.ts": 'await import("./dir\\\\foo%20bar.ts");\nawait import("./dir\\\\plain.ts");\n',
    });
    expect(run(root, "./entry.ts")).toBe(
      `OK ${urlOf(root, "dir/foo bar.ts")}\nOK ${urlOf(root, "dir/plain.ts")}\n`,
    );
  });

  test("a # beside non-ASCII text still resolves through oxc-node", () => {
    // oxc_resolver drops its `\0#` escape byte by byte and used to mangle
    // `õ`, so `.tsx` and extensionless imports fell back to Node and failed.
    const root = fixture({
      "p#õ/main.tsx":
        'import { v } from "./dép";\nconst url: string = import.meta.url;\nconsole.log("OK", v, url);\n',
      "p#õ/dép.ts": "export const v: number = 1;\n",
      p: WRONG,
      "entry.ts": 'await import("./p%23%C3%B5/main.tsx");\nawait import("./%C3%A9%23x.ts");\n',
      "é#x.ts": 'const n: number = 2;\nconsole.log("OK", n);\n',
      "é.ts": WRONG,
    });
    const main = `OK 1 ${urlOf(root, "p#õ/main.tsx")}\n`;
    expect(run(root, "./p#õ/main.tsx")).toBe(main);
    expect(run(root, "./entry.ts")).toBe(`${main}OK 2\n`);
  });

  test.skipIf(isWindows)("a ? directory resolves through oxc-node", () => {
    const root = fixture({ "d?x/main.tsx": OK, d: WRONG });
    expect(run(root, "./d?x/main.tsx")).toBe(`OK ${urlOf(root, "d?x/main.tsx")}\n`);
  });

  test("a tsconfig in a # directory applies its compiler options", () => {
    const root = fixture({
      "p#1/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "h" } }),
      "p#1/src/main.tsx": 'const h = (tag: string) => `h:${tag}`;\nconsole.log("OK", <div />);\n',
    });
    expect(run(root, "./p#1/src/main.tsx")).toBe("OK h:div\n");
  });

  test("createResolve emits the percent-encoded URL with the suffix verbatim", () => {
    // An identity `nextResolve` shows the hook's own URL: Node's default
    // resolver re-canonicalizes it, which would hide an encoding mistake.
    const root = fixture({
      "hash#dir/main%41 õ.ts": OK,
      hash: WRONG,
      "hash#dir/mainA õ.ts": WRONG,
    });
    const file = join(root, "hash#dir/main%41 õ.ts");
    const specifier = `${pathToFileURL(file).href}?v=1#frag`;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createResolve } from "@oxc-node/core";
const out = await createResolve({}, ${JSON.stringify(specifier)}, { conditions: ["node", "import"], importAttributes: {} }, (s, c) => ({ url: s, format: c?.format }));
console.log(out.url, out.format);`,
      ],
      { cwd: root, encoding: "utf8", env: ENV, timeout: 30_000 },
    );
    expect(result.error, result.error?.message).toBeFalsy();
    expect(result.status, result.stderr).toBe(0);
    // The format comes from oxc-node's own resolution: Node's fallback
    // reports none.
    const [url, format] = result.stdout.trim().split(" ");
    expect(format).toBe("module");
    expect(url.endsWith("/hash%23dir/main%2541%20%C3%B5.ts?v=1#frag"), url).toBe(true);
    expect(realpathSync.native(fileURLToPath(url))).toBe(realpathSync.native(file));
  });
});
