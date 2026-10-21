import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import {
  cleanEnv,
  EMULATED,
  POSIX,
  project,
  removeProjects,
  startOxnode,
  stopAll,
} from "./helpers/watch.js";

/**
 * A tool with a loader of its own runs the watcher (issue #871): `runWatch` from
 * `@oxc-node/cli/watch` starts the app with the tool's `--import`, under the tool's
 * name, and the loader reports to it through `@oxc-node/core/signal-ack` and
 * `@oxc-node/core/watch-report`, with the binding's functions passed in.
 */
afterEach(stopAll);
afterAll(removeProjects);

const DIST = fileURLToPath(new URL("../../cli/dist/", import.meta.url));
const CORE = fileURLToPath(new URL("../../core/", import.meta.url));
// The watcher makes an ack socket on POSIX when its path fits (run.ts `createSignalAck`).
const ACK = POSIX && Buffer.byteLength(join(tmpdir(), "oxnode-9999999-abcdef12.sock")) <= 100;

const LOADER = `import { createRequire, registerHooks } from "node:module";
import { isMainThread } from "node:worker_threads";

import { createResolve, enableWatchReport, load, takeWatchDependencies } from "@oxc-node/core";
import { installSignalAck } from "@oxc-node/core/signal-ack";
import { watchSink, withFlush } from "@oxc-node/core/watch-report";

console.log("LOADER", typeof process.env.OXNODE_SIGNAL_ACK);
if (isMainThread) installSignalAck();
const sink = watchSink();
if (sink) enableWatchReport();
const resolve = (specifier, context, next) =>
  createResolve({ getCurrentDirectory: () => process.cwd() }, specifier, context, next);
const hooks = { resolve, load: (url, context, next) => load(url, context, next) };
registerHooks(
  sink
    ? {
        resolve: withFlush(hooks.resolve, sink, takeWatchDependencies),
        load: withFlush(hooks.load, sink, takeWatchDependencies),
      }
    : hooks,
);
globalThis.CUSTOM = "custom";
`;

const EMBED = `import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runWatch } from "@oxc-node/cli/watch";

const hooks = new URL("./loader/hooks.mjs", import.meta.url);
process.exitCode = await runWatch(process.argv.slice(2), {
  name: "vpx watch",
  loaderArgs: ["--import", hooks.href],
  ignoreDirs: [
    fileURLToPath(new URL("./loader/", import.meta.url)),
    dirname(fileURLToPath(import.meta.resolve("@oxc-node/core/watch-report"))),
  ],
});
`;

const KEEP = "setInterval(() => {}, 1000);\n";
const value = (v: string) => `export const v: string = ${JSON.stringify(v)};\n`;
const paths = (dir: string) =>
  JSON.stringify({ compilerOptions: { paths: { "@lib/*": [`./${dir}/*`] } } });

function embedProject() {
  return project(
    {
      "package.json": JSON.stringify({ private: true, type: "module" }),
      "loader/hooks.mjs": LOADER,
      "embed.mjs": EMBED,
      "tsconfig.json": paths("a"),
      "main.ts":
        'import { v } from "./dep.js";\nimport { w } from "@lib/value";\n' +
        'const register = process.execArgv.some((a) => a.includes("register"));\n' +
        'console.log("RUN", v, w, globalThis.CUSTOM, register, typeof process.env.OXNODE_SIGNAL_ACK);\n' +
        KEEP,
      "dep.ts": value("v1"),
      "a/value.ts": 'export const w: string = "a";\n',
      "b/value.ts": 'export const w: string = "b";\n',
    },
    { linkCli: true },
  );
}

const embed = (args: string[], cwd: string) =>
  spawnSync(process.execPath, ["embed.mjs", ...args], { cwd, env: cleanEnv(), encoding: "utf8" });

describe("the command line under another name", () => {
  test("an error names the tool", () => {
    const root = embedProject();
    const r = embed(["--kill-signal"], root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^vpx watch: /);
    expect(r.stderr).toContain("\nUsage: vpx watch [options]");
    expect(r.stderr).toContain('Run "vpx watch --help" for the options.');
    expect(r.stderr).not.toContain("oxnode");
  });

  test("a flag that needs an entry file points to no oxnode command", () => {
    const r = embed(["-e", "1"], embedProject());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-e is not supported by vpx watch: vpx watch needs an entry file\n");
    expect(r.stderr).not.toContain("oxnode");
  });

  test("--help", () => {
    const r = embed(["--help"], embedProject());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: vpx watch /);
    expect(r.stdout).not.toMatch(/oxnode watch|oxnode --watch/);
  });
});

describe("the bundle", () => {
  test("dist/watch.js reaches neither the CLI nor clipanion nor the binding", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const code = readFileSync(join(DIST, file), "utf8");
      expect(code, file).not.toMatch(/clipanion|from "@oxc-node\/core"/);
      for (const [, next] of code.matchAll(/(?:from|import)\s*"\.\/([^"]+)"/g)) visit(next);
    };
    visit("watch.js");
    expect(seen.has("index.js")).toBe(false);
  });

  test("importing @oxc-node/cli/watch starts nothing", () => {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'await import("@oxc-node/cli/watch");'],
      { cwd: embedProject(), env: cleanEnv(), encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  test("the child-side entries load no binding", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { createRequire } from "node:module";\n' +
          'const { watchSink, flush, withFlush, createRelay } = await import("@oxc-node/core/watch-report");\n' +
          'const { installSignalAck } = await import("@oxc-node/core/signal-ack");\n' +
          "const kinds = [watchSink, flush, withFlush, createRelay, installSignalAck].map((f) => typeof f);\n" +
          "const loaded = Object.keys(createRequire(import.meta.url).cache);\n" +
          'const required = createRequire(import.meta.url)("@oxc-node/core/watch-report");\n' +
          "console.log(kinds.join(), loaded.length, typeof required.withFlush);",
      ],
      { cwd: embedProject(), env: cleanEnv(), encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    // `require()` works too, for a CommonJS preload.
    expect(r.stdout.trim()).toBe("function,function,function,function,function 0 function");
  });

  test("a path into dist still resolves", () => {
    const root = embedProject();
    // `require` follows the link to the package folder.
    expect(createRequire(join(root, "x.js")).resolve("@oxc-node/cli/dist/index.js")).toBe(
      join(DIST, "index.js"),
    );
  });

  test("the core exports survive the build's rewrite of package.json", () => {
    const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
    const rewrite = readFileSync(join(CORE, "reexport-oxc-runtime.mjs"), "utf8");
    for (const entry of ["./signal-ack", "./watch-report"]) {
      expect(pkg.exports[entry]).toBeDefined();
      expect(rewrite).toContain(`"${entry}"`);
    }
  });
});

describe("flush and withFlush take the binding's function", () => {
  test("one message per URL", async () => {
    const { flush, withFlush } = await import("@oxc-node/core/watch-report");
    const sent: unknown[] = [];
    flush(
      (m) => sent.push(m),
      () => ["file:///a", "file:///b"],
    );
    expect(sent).toEqual([
      { "watch:import": ["file:///a"], "oxc-node": true },
      { "watch:import": ["file:///b"], "oxc-node": true },
    ]);

    sent.length = 0;
    let n = 0;
    const take = () => [`file:///${++n}`];
    const sink = (m: unknown) => sent.push(m);
    const ok = withFlush(
      function (this: unknown, x: number) {
        return [this, x];
      },
      sink,
      take,
    );
    expect(ok.call("self", 1)).toEqual(["self", 1]);
    const fail = withFlush(
      () => {
        throw new Error("no");
      },
      sink,
      take,
    );
    expect(() => fail()).toThrow("no");
    await expect(withFlush(async () => 2, sink, take)()).resolves.toBe(2);
    await expect(
      withFlush(async () => Promise.reject(new Error("later")), sink, take)(),
    ).rejects.toThrow("later");
    expect(sent).toHaveLength(4);
  });
});

describe.skipIf(EMULATED || !registerHooks)("a run with the tool's loader", () => {
  test("restarts on a dependency and on tsconfig.json, under the tool's tag", async () => {
    const root = embedProject();
    const o = startOxnode(["--no-clear-screen", "main.ts"], root, {
      script: join(root, "embed.mjs"),
    });
    // The loader removed OXNODE_SIGNAL_ACK before the app ran.
    await o.waitFor(/^RUN v1 a custom false undefined\n/m);
    expect(o.stdout()).toMatch(new RegExp(`^LOADER ${ACK ? "string" : "undefined"}\\n`, "m"));
    // The loader's own files are reported by Node.js, and left out.
    await o.waitDebug(
      new RegExp(`^skip ${escape(join(root, "loader", "hooks.mjs"))} \\(default\\)$`, "m"),
    );

    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), /^RUN v2 a custom /m);
    expect(o.stdout()).toMatch(/\[vpx\] change in \.[\\/]dep\.ts, restarting\n/);

    // Only the loader knows it read tsconfig.json: its report came through `take`.
    await o.watched(join(root, "tsconfig.json"));
    await o.editUntil(join(root, "tsconfig.json"), () => paths("b"), /^RUN v2 b custom /m);
    expect(o.stdout()).toMatch(/\[vpx\] change in \.[\\/]tsconfig\.json, restarting\n/);
    expect(o.stdout()).not.toContain("[oxnode]");
  });
});

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
