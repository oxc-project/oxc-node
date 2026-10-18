import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Watch mode (`node --watch`, `oxnode watch`) restarts on what the child reports
 * over IPC. Node.js reports the modules it loads; oxc-node adds the tsconfig
 * files it read and the paths a failed resolve looked for, so editing a config
 * or creating the `./x.ts` a `./x.js` import wants restarts too (issue #450).
 * These run the child the way a watch parent does and record what it sends.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));
// By its real path, as in preserve-symlinks.spec.ts: the binding package (the
// WASI one in CI) is found from there.
const REGISTER = ["--import", pathToFileURL(join(CORE, "register.mjs")).href];
const MAJOR = Number(process.versions.node.split(".")[0]);

const ENV = {
  ...process.env,
  NODE_OPTIONS: undefined,
  OXC_LOG: undefined,
  OXC_TSCONFIG_PATH: undefined,
  TS_NODE_PROJECT: undefined,
  OXNODE_SIGNAL_ACK: undefined,
  WATCH_REPORT_DEPENDENCIES: undefined,
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }
});

function project(files: Record<string, string>): string {
  // The real path, since Node.js reports real paths (macOS keeps tmp under a link).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oxc-node-watch-report-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

interface Spied {
  messages: unknown[];
  /** Every reported path inside the project, relative and with `/`. */
  paths: string[];
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run `args` the way a watch parent does and collect what the child sends. */
function spy(
  root: string,
  args: string[],
  env: Record<string, string | undefined> = { WATCH_REPORT_DEPENDENCIES: "1" },
): Promise<Spied> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...ENV, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const messages: unknown[] = [];
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.on("message", (message) => messages.push(message));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ messages, paths: inside(root, messages), stdout, stderr, code });
    });
  });
}

function inside(root: string, messages: unknown[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const key of ["watch:import", "watch:require"]) {
      const list = (message as Record<string, unknown>)?.[key];
      if (!Array.isArray(list)) {
        continue;
      }
      for (const entry of list) {
        if (typeof entry !== "string") {
          continue;
        }
        const path = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
        if (path.startsWith(root + sep)) {
          paths.add(relative(root, path).split(sep).join("/"));
        }
      }
    }
  }
  return [...paths].sort();
}

const ESM = JSON.stringify({ private: true, type: "module" });

describe("tsconfig files", () => {
  test("a discovered config, a two-level extends chain and a package extends", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": JSON.stringify({ extends: ["./cfg/base.json", "shared/tsconfig.json"] }),
      "cfg/base.json": JSON.stringify({ extends: "./deeper.json" }),
      "cfg/deeper.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "node_modules/shared/package.json": JSON.stringify({ name: "shared" }),
      "node_modules/shared/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "main.ts": 'const ok: string = "ok";\nconsole.log(ok);\n',
    });
    const { paths, stdout, code } = await spy(root, [...REGISTER, "./main.ts"]);
    expect(code).toBe(0);
    expect(stdout).toBe("ok\n");
    expect(paths).toEqual(
      expect.arrayContaining([
        "tsconfig.json",
        "cfg/base.json",
        "cfg/deeper.json",
        "node_modules/shared/tsconfig.json",
      ]),
    );
  });

  test("an explicit config is reported with its chain, not the discovered one", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": JSON.stringify({ extends: "./found-base.json" }),
      "found-base.json": "{}",
      "custom/tsconfig.custom.json": JSON.stringify({ extends: "./custom-base.json" }),
      "custom/custom-base.json": "{}",
      "other.json": "{}",
      "main.ts": 'const ok: string = "ok";\nconsole.log(ok);\n',
    });
    const watching = { WATCH_REPORT_DEPENDENCIES: "1" };
    const explicit = await spy(root, [...REGISTER, "./main.ts"], {
      ...watching,
      OXC_TSCONFIG_PATH: "custom/tsconfig.custom.json",
    });
    expect(explicit.code).toBe(0);
    expect(explicit.paths).toEqual([
      "custom/custom-base.json",
      "custom/tsconfig.custom.json",
      "main.ts",
    ]);

    // `TS_NODE_PROJECT` wins over `OXC_TSCONFIG_PATH`.
    const tsNode = await spy(root, [...REGISTER, "./main.ts"], {
      ...watching,
      OXC_TSCONFIG_PATH: "custom/tsconfig.custom.json",
      TS_NODE_PROJECT: "other.json",
    });
    expect(tsNode.paths).toEqual(["main.ts", "other.json"]);

    // `setTsconfigPath()` from a preload, ahead of the register.
    writeFileSync(
      join(root, "preload.mjs"),
      `import { setTsconfigPath } from ${JSON.stringify(pathToFileURL(join(CORE, "index.js")).href)};\n` +
        'setTsconfigPath("other.json");\n',
    );
    const api = await spy(root, ["--import", "./preload.mjs", ...REGISTER, "./main.ts"], {
      ...watching,
      OXC_TSCONFIG_PATH: "custom/tsconfig.custom.json",
    });
    expect(api.code, api.stderr).toBe(0);
    expect(api.paths).toEqual(["main.ts", "other.json", "preload.mjs"]);
  });

  test("a nested config with its root base, and a config found through references", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "packages/app/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
      "packages/app/main.ts": 'import "../solution/src/lib.ts";\nconsole.log("app");\n',
      "packages/solution/tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.lib.json" }],
      }),
      "packages/solution/tsconfig.lib.json": JSON.stringify({ include: ["src"] }),
      "packages/solution/src/lib.ts": 'export const lib: string = "lib";\n',
    });
    const { paths, code, stderr } = await spy(root, [...REGISTER, "./packages/app/main.ts"]);
    expect(code, stderr).toBe(0);
    expect(paths).toEqual(
      expect.arrayContaining([
        "packages/app/tsconfig.json",
        "tsconfig.base.json",
        "packages/solution/tsconfig.json",
        "packages/solution/tsconfig.lib.json",
      ]),
    );
  });

  test("a .cts entry reports the tsconfig its transform read", async () => {
    const root = project({
      "package.json": JSON.stringify({ private: true }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "main.cts": 'const ok: string = "ok";\nconsole.log(ok);\n',
    });
    const { paths, stdout, code } = await spy(root, [...REGISTER, "./main.cts"]);
    expect(code).toBe(0);
    expect(stdout).toBe("ok\n");
    expect(paths).toContain("tsconfig.json");
  });
});

describe("paths a failed resolve looked for", () => {
  test("TypeScript candidates, a directory index and a paths alias target", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@alias/*": ["./aliased/*"] } },
      }),
      "dir/other.ts": "export {};\n",
      "main.ts": [
        'for (const specifier of ["./later.js", "./later.mjs", "./later.cjs", "./dir", "@alias/missing"]) {',
        "  try {",
        "    await import(specifier);",
        "  } catch {}",
        "}",
        'console.log("done");',
        "",
      ].join("\n"),
    });
    const { paths, stdout, code } = await spy(root, [...REGISTER, "./main.ts"]);
    expect(code).toBe(0);
    expect(stdout).toBe("done\n");
    expect(paths).toEqual(
      expect.arrayContaining([
        "later.ts",
        "later.tsx",
        "later.mts",
        "later.cts",
        "dir/index.ts",
        "aliased/missing.ts",
      ]),
    );
  });

  test("a miss right before process.exit() is still reported", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": 'try {\n  await import("./gone.js");\n} catch {}\nprocess.exit(0);\n',
    });
    const { paths, code } = await spy(root, [...REGISTER, "./main.ts"]);
    expect(code).toBe(0);
    expect(paths).toContain("gone.ts");
  });

  test("a miss that fails the entry is still reported", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": 'import "./missing.js";\n',
    });
    const { paths, code, stderr } = await spy(root, [...REGISTER, "./main.ts"]);
    expect(code).toBe(1);
    expect(stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(paths).toContain("missing.ts");
  });

  test("never package.json or node_modules, and one absolute file: URL per message", async () => {
    const root = project({
      "package.json": ESM,
      "src/package.json": ESM,
      "src/main.ts": [
        'for (const specifier of ["./nope.js", "missing-package", "missing-package/sub.js"]) {',
        "  try {",
        "    await import(specifier);",
        "  } catch {}",
        "}",
        "",
      ].join("\n"),
    });
    const { messages, paths, code } = await spy(root, [...REGISTER, "./src/main.ts"]);
    expect(code).toBe(0);
    expect(paths).toContain("src/nope.ts");
    expect(paths.filter((path) => path.endsWith("package.json"))).toEqual([]);
    expect(paths.filter((path) => path.split("/").includes("node_modules"))).toEqual([]);
    for (const message of messages) {
      const urls = (message as Record<string, unknown>)["watch:import"];
      if (urls === undefined) {
        continue;
      }
      expect(urls).toHaveLength(1);
      const [url] = urls as string[];
      if (url.startsWith("file:") && fileURLToPath(url).startsWith(root)) {
        expect(url.startsWith("file:///")).toBe(true);
        expect(isAbsolute(fileURLToPath(url))).toBe(true);
      }
    }
  });

  test("a worker's miss reaches the main thread, never the app's worker.on('message')", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": [
        'import { Worker } from "node:worker_threads";',
        'const worker = new Worker(new URL("./worker.ts", import.meta.url));',
        'worker.on("message", (message) => console.log("app got " + JSON.stringify(message)));',
        'await new Promise((resolve) => worker.on("exit", resolve));',
        // The reports travel on a channel of their own; give it a turn after the exit.
        "await new Promise((resolve) => setTimeout(resolve, 200));",
        "",
      ].join("\n"),
      "worker.ts": [
        'import { parentPort } from "node:worker_threads";',
        "try {",
        '  await import("./from-worker.js");',
        "} catch {}",
        'parentPort!.postMessage({ hello: "app" });',
        "",
      ].join("\n"),
    });
    const { paths, stdout, code, stderr } = await spy(root, [...REGISTER, "./main.ts"]);
    expect(code, stderr).toBe(0);
    expect(paths).toContain("from-worker.ts");
    // Node.js 24+ also relays the worker's own module reports (and hands them to
    // the app as well); Node.js 22 reports nothing from workers.
    if (MAJOR >= 24) {
      expect(paths).toContain("worker.ts");
    }
    const appGot = stdout.split("\n").filter((line) => line.startsWith("app got "));
    expect(appGot).toContain('app got {"hello":"app"}');
    // Whatever Node.js itself relays, nothing of oxc-node's reaches the app.
    expect(appGot.filter((line) => line.includes("from-worker.ts"))).toEqual([]);
  });
});

describe("when nobody is watching", () => {
  test("no WATCH_REPORT_DEPENDENCIES: no messages", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": "{}",
      "main.ts": 'try {\n  await import("./later.js");\n} catch {}\nconsole.log("ok");\n',
    });
    const { messages, stdout, code } = await spy(root, [...REGISTER, "./main.ts"], {});
    expect(code).toBe(0);
    expect(stdout).toBe("ok\n");
    expect(messages).toEqual([]);
  });

  test("WATCH_REPORT_DEPENDENCIES without an IPC channel runs as usual", () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": "{}",
      "main.ts": 'try {\n  await import("./later.js");\n} catch {}\nconsole.log("ok");\n',
    });
    const result = spawnSync(process.execPath, [...REGISTER, "./main.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...ENV, WATCH_REPORT_DEPENDENCIES: "1" },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("ok\n");
  });
});
