import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * `import.meta.glob`, expanded by the transform as Vite expands it, once
 * `OXC_IMPORT_GLOB` turns it on. Each case runs a script under the register
 * hooks: the in-thread hooks on Node.js 26.2 and later, the `module.register()`
 * thread before that, and the `pirates` hook for `require()`.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));
// By its real path, as in watch-report.spec.ts: the binding package is found from there.
const REGISTER = ["--import", pathToFileURL(join(CORE, "register.mjs")).href];

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }
});

function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oxc-node-import-glob-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function run(root: string, entry: string, env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [...REGISTER, entry], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      OXC_LOG: undefined,
      WATCH_REPORT_DEPENDENCIES: undefined,
      OXC_IMPORT_GLOB: "1",
      ...env,
    },
    timeout: 30_000,
  });
  expect(result.error, result.error?.message).toBeFalsy();
  return result;
}

const ESM = JSON.stringify({ private: true, type: "module" });
const UNTYPED = JSON.stringify({ private: true });
// The script from Vite+ issue #3525.
const SERVER =
  "const routes = import.meta.glob('./routes/*.ts');\nconsole.log(Object.keys(routes));\n";
const HEALTH = 'export const name: string = "health";\n';

describe("the script from the issue", () => {
  test("as an ES module entry", () => {
    const root = project({
      "package.json": ESM,
      "src/server.ts": SERVER,
      "src/routes/health.ts": HEALTH,
    });
    const result = run(root, "./src/server.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("[ './routes/health.ts' ]\n");
  });

  test("in a package without type", () => {
    const root = project({
      "package.json": UNTYPED,
      "src/server.ts": SERVER,
      "src/routes/health.ts": HEALTH,
    });
    const result = run(root, "./src/server.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("[ './routes/health.ts' ]\n");
  });

  test("through require(), where the output alone decides the format", () => {
    const root = project({
      "package.json": UNTYPED,
      "main.cjs": 'require("./src/server.ts");\n',
      "src/server.ts": SERVER,
      "src/routes/health.ts": HEALTH,
    });
    const result = run(root, "./main.cjs");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("[ './routes/health.ts' ]\n");
  });

  test("off without OXC_IMPORT_GLOB, as in Node.js", () => {
    const root = project({
      "package.json": ESM,
      "src/server.ts": SERVER,
      "src/routes/health.ts": HEALTH,
    });
    for (const value of [undefined, "", "0", "false"]) {
      const result = run(root, "./src/server.ts", { OXC_IMPORT_GLOB: value });
      expect(result.status, String(value)).toBe(1);
      expect(result.stderr).toContain("TypeError: (intermediate value).glob is not a function");
    }
  });
});

describe("the forms", () => {
  test("eager modules run before the importer's own imports", () => {
    const root = project({
      "package.json": ESM,
      "main.ts": [
        'import "./instrument.ts";',
        "const routes = import.meta.glob<{ name: string }>('./routes/*.ts', { eager: true });",
        'const names = import.meta.glob("./routes/*.ts", { eager: true, import: "name" });',
        'console.log("main", Object.keys(routes), Object.values(names));',
        "",
      ].join("\n"),
      "instrument.ts": 'console.log("instrument");\n',
      "routes/a.ts": 'console.log("route a");\nexport const name: string = "a";\n',
      "routes/b.ts": 'console.log("route b");\nexport const name: string = "b";\n',
    });
    const result = run(root, "./main.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "route a\nroute b\ninstrument\nmain [ './routes/a.ts', './routes/b.ts' ] [ 'a', 'b' ]\n",
    );
  });

  test("lazy imports, base, a negative pattern, and Object.values()", () => {
    const root = project({
      "package.json": ESM,
      "main.mts": [
        "const lazy = import.meta.glob(['./**/*.ts', '!**/*.test.ts'], {",
        "  base: './src/routes',",
        "  import: 'name',",
        "});",
        "console.log(Object.keys(lazy), await lazy['./deep/b.ts']());",
        "const values = Object.values(import.meta.glob('./src/routes/*.ts'));",
        "console.log(values.length, (await values[0]()).name);",
        "",
      ].join("\n"),
      "src/routes/a.ts": 'export const name: string = "a";\n',
      "src/routes/a.test.ts": 'export const name: string = "test";\n',
      "src/routes/deep/b.ts": 'export const name: string = "b";\n',
    });
    const result = run(root, "./main.mts");
    expect(result.status, result.stderr).toBe(0);
    // `a.test.ts` sorts before `a.ts`.
    expect(result.stdout).toBe("[ './a.ts', './deep/b.ts' ] b\n2 test\n");
  });
});

describe("errors", () => {
  test("a pattern that is not a literal, with a code frame", () => {
    const root = project({
      "package.json": ESM,
      "server.ts": 'const pattern = "./routes/*.ts";\nconst routes = import.meta.glob(pattern);\n',
    });
    const result = run(root, "./server.ts");
    expect(result.status).toBe(1);
    // The load hook names the file by its URL, the code frame by its path.
    expect(result.stderr).toContain(
      `Failed to transform ${pathToFileURL(join(root, "server.ts")).href}:`,
    );
    expect(result.stderr).toContain("x Invalid glob import syntax: Could only use literals");
    expect(result.stderr).toContain(`${join(root, "server.ts")}:2:33]`);
    expect(result.stderr).toContain("2 | const routes = import.meta.glob(pattern);");
  });

  test("a .cts file keeps its error", () => {
    const root = project({
      "package.json": UNTYPED,
      "main.cts": "const routes = import.meta.glob('./routes/*.ts');\nmodule.exports = routes;\n",
      "routes/a.ts": HEALTH,
    });
    const result = run(root, "./main.cts");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "a `.cts` file is CommonJS, but this one uses ES module syntax (`import`, `export` or `import.meta`)",
    );
  });
});
