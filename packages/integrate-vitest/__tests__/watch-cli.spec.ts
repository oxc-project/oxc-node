import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import {
  atomicWrite,
  CLI,
  cleanEnv,
  EMULATED,
  isGone,
  MAJOR,
  POSIX,
  project,
  reason,
  removeProjects,
  startOxnode,
  stopAll,
  write,
} from "./helpers/watch.js";

/**
 * `oxnode watch` runs the app, watches every file it uses (as reported over
 * IPC, plus tsconfig files, missing files, --include and --env-file) and runs
 * it again when one changes (issue #450). The apps print `RUN <value> <pid>`;
 * the tests wait for the OXNODE_WATCH_DEBUG lines before they edit anything.
 *
 * A check that something does NOT restart edits a sentinel file afterwards:
 * the next restart must name the sentinel, and be the very next run.
 */
afterEach(stopAll);
afterAll(removeProjects);

const ESM = JSON.stringify({ private: true, type: "module" });
const KEEP = "setInterval(() => {}, 1000);\n";
const value = (v: string) => `export const v: string = ${JSON.stringify(v)};\n`;
const sentinel = (s: string) => `export const s: string = ${JSON.stringify(s)};\n`;
/** Prints the value of ./dep.ts and stays alive, as a server does. */
const MAIN = `import { v } from "./dep.js";\nconsole.log("RUN", v, process.pid);\n${KEEP}`;
const runLine = (v: string) => new RegExp(`^RUN ${v} \\d+\\n`, "m");
const count = (text: string, re: RegExp) => text.match(new RegExp(re, "g"))?.length ?? 0;

const cli = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(), encoding: "utf8" });

describe("the command line", () => {
  test("oxnode watch --help exits 0", () => {
    const r = cli(["watch", "--help"], project({}));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Usage: oxnode watch");
  });

  test("oxnode watch with no entry exits 1", () => {
    const r = cli(["watch"], project({}));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing <entry>");
  });

  test("oxnode --help lists watch", () => {
    const r = cli(["--help"], project({}));
    expect(r.status, r.stderr).toBe(0);
    // Listed by the binary's path, then the command.
    expect(r.stdout).toMatch(
      / watch \.\.\.\n\s+Run a script and run it again when a file it uses changes/,
    );
  });
});

// One test at a time (Vitest 5 runs a file's tests in order; it has no `describe.sequential`).
describe.skipIf(EMULATED)("restarts", () => {
  test("an ES module dependency edit", async () => {
    const root = project({ "package.json": ESM, "main.ts": MAIN, "dep.ts": value("v1") });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"));
    expect(o.stdout()).toMatch(reason("dep.ts"));
  });

  test("a CommonJS .cts dependency edit", async () => {
    const root = project({
      "main.cts": `const { v } = require("./dep.cts");\nconsole.log("RUN", v, process.pid);\n${KEEP}`,
      "dep.cts": 'const v: string = "v1";\nmodule.exports = { v };\n',
    });
    const o = startOxnode(["watch", "main.cts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.cts"));
    await o.editUntil(
      join(root, "dep.cts"),
      () => 'const v: string = "v2";\nmodule.exports = { v };\n',
      runLine("v2"),
    );
  });

  test("a save that writes a temp file and renames it over the original", async () => {
    const root = project({ "package.json": ESM, "main.ts": MAIN, "dep.ts": value("v1") });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"), atomicWrite);
    // And again: the watch survives the file being replaced.
    await o.editUntil(join(root, "dep.ts"), () => value("v3"), runLine("v3"), atomicWrite);
  });

  test("a crash waits for a fix, then runs", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": MAIN,
      "dep.ts": `throw new Error("boom");\n${value("never")}`,
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(/\[oxnode\] exited with code 1 — waiting for changes/);
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("fixed"), runLine("fixed"));
    expect(o.stdout()).toMatch(reason("dep.ts", "rerunning"));
  });

  test("creating a missing import, also in a folder that does not exist yet", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `const load = (p: string) => import(p).then((m) => m.v as string, () => "none");
console.log("RUN", await load("./later.js"), await load("./gen/deep/x.js"), process.pid);
${KEEP}`,
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("none none"));
    await o.watched(join(root, "later.ts"));
    await o.editUntil(join(root, "later.ts"), () => value("later"), runLine("later none"));
    await o.watched(join(root, "gen/deep/x.ts"));
    await o.editUntil(join(root, "gen/deep/x.ts"), () => value("x"), runLine("later x"));
  });

  test("tsconfig.json and the config it extends", async () => {
    const paths = (dir: string) => ({ paths: { "@lib/*": [`./${dir}/*`] } });
    const root = project({
      "package.json": ESM,
      "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      "base.json": JSON.stringify({ compilerOptions: paths("a") }),
      "main.ts": `import { v } from "@lib/value";\nconsole.log("RUN", v, process.pid);\n${KEEP}`,
      "a/value.ts": value("a"),
      "b/value.ts": value("b"),
      "c/value.ts": value("c"),
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("a"));
    await o.watched(join(root, "base.json"));
    await o.editUntil(
      join(root, "base.json"),
      () => JSON.stringify({ compilerOptions: paths("b") }),
      runLine("b"),
    );
    await o.watched(join(root, "tsconfig.json"));
    await o.editUntil(
      join(root, "tsconfig.json"),
      () => JSON.stringify({ extends: "./base.json", compilerOptions: paths("c") }),
      runLine("c"),
    );
  });

  test("the config named by --tsconfig", async () => {
    const paths = (dir: string) =>
      JSON.stringify({ compilerOptions: { paths: { "@lib/*": [`./${dir}/*`] } } });
    const root = project({
      "package.json": ESM,
      // Found by discovery, and not used: --tsconfig names another.
      "tsconfig.json": paths("a"),
      "custom.json": paths("b"),
      "main.ts": `import { v } from "@lib/value";\nconsole.log("RUN", v, process.pid);\n${KEEP}`,
      "a/value.ts": value("a"),
      "b/value.ts": value("b"),
      "c/value.ts": value("c"),
    });
    const o = startOxnode(["watch", "--tsconfig", "custom.json", "main.ts"], root);
    await o.waitFor(runLine("b"));
    await o.watched(join(root, "custom.json"));
    await o.editUntil(join(root, "custom.json"), () => paths("c"), runLine("c"));
  });

  test("--include: a file the app only reads, and one created later", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { readdirSync, readFileSync } from "node:fs";
const files = readdirSync("data").sort().map((f) => f + "=" + readFileSync("data/" + f, "utf8").trim());
console.log("RUN", files.join(","), process.pid);
${KEEP}`,
      "data/a.json": "1",
    });
    const o = startOxnode(["watch", "--include", "data/*.json", "main.ts"], root);
    await o.waitFor(runLine("a.json=1"));
    await o.watched(join(root, "data/a.json"));
    await o.editUntil(join(root, "data/a.json"), () => "2", runLine("a.json=2"));
    await o.editUntil(join(root, "data/b.json"), () => "1", runLine("a.json=2,b.json=1"));
  });

  test("--exclude: an edit to an excluded dependency does not restart", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { v } from "./dep.js";\nimport { s } from "./sentinel.js";
console.log("RUN", v, s, process.pid);\n${KEEP}`,
      "dep.ts": value("v1"),
      "sentinel.ts": sentinel("s1"),
    });
    const o = startOxnode(["watch", "--exclude", "dep.ts", "main.ts"], root);
    await o.waitFor(runLine("v1 s1"));
    await o.waitDebug(new RegExp(`^skip ${escapeRe(join(root, "dep.ts"))} \\(exclude\\)$`, "m"));
    await o.watched(join(root, "sentinel.ts"));
    const from = o.mark();
    const before = o.runs().length;
    write(join(root, "dep.ts"), value("v2"));
    await o.editUntil(join(root, "sentinel.ts"), () => sentinel("s2"), runLine("v2 s2"));
    expect(o.runs()[before]).toMatch(/^v2 s2 /);
    expect(firstReason(o.stdout().slice(from))).toMatch(reason("sentinel.ts"));
  });

  test("node_modules is not watched unless --include names it", async () => {
    const files = {
      "package.json": ESM,
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", type: "module" }),
      "node_modules/pkg/index.js": 'export const p = "p1";\n',
      "main.ts": `import { p } from "pkg";\nimport { s } from "./sentinel.js";
console.log("RUN", p, s, process.pid);\n${KEEP}`,
      "sentinel.ts": sentinel("s1"),
    };
    const pkg = (root: string) => join(root, "node_modules/pkg/index.js");

    const root = project(files);
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("p1 s1"));
    await o.waitDebug(new RegExp(`^skip ${escapeRe(pkg(root))} \\(default\\)$`, "m"));
    await o.watched(join(root, "sentinel.ts"));
    const from = o.mark();
    const before = o.runs().length;
    write(pkg(root), 'export const p = "p2";\n');
    await o.editUntil(join(root, "sentinel.ts"), () => sentinel("s2"), runLine("p2 s2"));
    expect(o.runs()[before]).toMatch(/^p2 s2 /);
    expect(firstReason(o.stdout().slice(from))).toMatch(reason("sentinel.ts"));

    const optIn = project(files);
    const o2 = startOxnode(["watch", "--include", "node_modules/pkg/**", "main.ts"], optIn);
    await o2.waitFor(runLine("p1 s1"));
    await o2.watched(pkg(optIn));
    await o2.editUntil(pkg(optIn), () => 'export const p = "p2";\n', runLine("p2 s1"));
  });

  test("--preserve-symlinks: a linked workspace package is watched by its real path", async () => {
    const root = project({
      "package.json": ESM,
      "packages/pkg/package.json": JSON.stringify({ name: "pkg", type: "module" }),
      "packages/pkg/index.js": 'export const p = "p1";\n',
      "main.ts": `import { p } from "pkg";\nconsole.log("RUN", p, process.pid);\n${KEEP}`,
    });
    // The link path is under node_modules, and so ignored; its real path is not.
    symlinkSync(
      join(root, "packages/pkg"),
      join(root, "node_modules/pkg"),
      POSIX ? "dir" : "junction",
    );
    const real = join(root, "packages/pkg/index.js");
    const o = startOxnode(["watch", "--preserve-symlinks", "main.ts"], root);
    await o.waitFor(runLine("p1"));
    await o.watched(real);
    await o.editUntil(real, () => 'export const p = "p2";\n', runLine("p2"));
  });

  test("five writes within 20 ms restart once", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { v } from "./dep.js";\nimport { s } from "./sentinel.js";
console.log("RUN", v, s, process.pid);\n${KEEP}`,
      "dep.ts": value("v0"),
      "sentinel.ts": sentinel("s1"),
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("v0 s1"));
    await o.watched(join(root, "dep.ts"));
    await o.watched(join(root, "sentinel.ts"));
    // First show that the folder watch is live, so no write below is lost.
    await o.editUntil(join(root, "dep.ts"), () => value("live"), runLine("live s1"));
    const from = o.mark();
    const before = o.runs().length;
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(root, "dep.ts"), value(`b${i}`));
      await new Promise((r) => setTimeout(r, 4));
    }
    await o.waitFor(runLine("b5 s1"), 20_000, from);
    await o.editUntil(join(root, "sentinel.ts"), () => sentinel("s2"), runLine("b5 s2"));
    expect(
      o
        .runs()
        .slice(before, before + 2)
        .map((r) => r.split(" ", 2).join(" ")),
    ).toEqual(["b5 s1", "b5 s2"]);
    expect(count(o.stdout().slice(from), /\[oxnode\] change in /)).toBe(2);
    expect(firstReason(o.stdout().slice(from))).toMatch(reason("dep.ts"));
  });

  test("an edit to the entry, with Node.js flags before it and script args after it", async () => {
    const entry = (label: string) => `import which from "cond";
console.log("RUN", ${JSON.stringify(label)}, which, JSON.stringify(process.argv.slice(2)), process.pid);
${KEEP}`;
    const root = project({
      "package.json": ESM,
      "node_modules/cond/package.json": JSON.stringify({
        name: "cond",
        type: "module",
        exports: { custom: "./custom.js", default: "./default.js" },
      }),
      "node_modules/cond/custom.js": 'export default "custom";\n',
      "node_modules/cond/default.js": 'export default "default";\n',
      "main.ts": entry("one"),
    });
    // Watch flags after the entry belong to the script.
    const script = ["--include", "x", "--kill-timeout", "1"];
    const o = startOxnode(["watch", "--conditions", "custom", "main.ts", ...script], root);
    const args = JSON.stringify(script).replace(/[[\]]/g, "\\$&");
    await o.waitFor(new RegExp(`^RUN one custom ${args} \\d+\\n`, "m"));
    await o.watched(join(root, "main.ts"));
    await o.editUntil(
      join(root, "main.ts"),
      () => entry("two"),
      new RegExp(`^RUN two custom ${args} \\d+\\n`, "m"),
    );
    expect(o.stdout()).toMatch(reason("main.ts"));
  });

  test("an --env-file edit", async () => {
    const root = project({
      "package.json": ESM,
      ".env": "GREETING=one\n",
      "main.ts": `console.log("RUN", process.env.GREETING, process.pid);\n${KEEP}`,
    });
    const o = startOxnode(["watch", "--env-file=.env", "main.ts"], root);
    await o.waitFor(runLine("one"));
    await o.watched(join(root, ".env"));
    await o.editUntil(join(root, ".env"), () => "GREETING=two\n", runLine("two"));
  });

  // Node.js 22 reports nothing from worker threads.
  test.skipIf(MAJOR < 24)("an edit to a file a worker imports", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { Worker } from "node:worker_threads";
// Node.js 24+ also hands its own watch reports from the worker to this listener.
new Worker(new URL("./worker.ts", import.meta.url)).on("message", (v) => {
  if (typeof v === "string") console.log("RUN", v, process.pid);
});
${KEEP}`,
      "worker.ts": `import { parentPort } from "node:worker_threads";
import { v } from "./dep.js";
parentPort!.postMessage(v);
`,
      "dep.ts": value("v1"),
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"));
  });

  test("deleting a dependency reruns, and creating it again reruns", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `const v = await import("./opt.js").then((m) => m.v as string, () => "gone");
console.log("RUN", v, process.pid);
${KEEP}`,
      "opt.ts": value("here"),
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("here"));
    await o.watched(join(root, "opt.ts"));
    // First show that the folder watch is live: a delete cannot be written again.
    await o.editUntil(join(root, "opt.ts"), () => value("live"), runLine("live"));
    const from = o.mark();
    rmSync(join(root, "opt.ts"));
    await o.waitFor(runLine("gone"), 20_000, from);
    expect(firstReason(o.stdout().slice(from))).toMatch(reason("opt.ts"));
    await o.editUntil(join(root, "opt.ts"), () => value("back"), runLine("back"));
  });

  test("--poll", async () => {
    const root = project({ "package.json": ESM, "main.ts": MAIN, "dep.ts": value("v1") });
    const o = startOxnode(["watch", "--poll=100", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"), { poll: true });
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"));
  });
});

describe.skipIf(EMULATED)("the terminal", () => {
  test("--rerun-on-enter: a bare Return on a pipe reruns, other text does not", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { s } from "./sentinel.js";\nconsole.log("RUN", s, process.pid);\n${KEEP}`,
      "sentinel.ts": sentinel("s1"),
    });
    const o = startOxnode(["watch", "--rerun-on-enter", "main.ts"], root);
    await o.waitFor(runLine("s1"));
    await o.watched(join(root, "sentinel.ts"));
    const from = o.mark();
    const before = o.runs().length;
    o.child.stdin!.write("abc\n");
    await o.editUntil(join(root, "sentinel.ts"), () => sentinel("s2"), runLine("s2"));
    expect(o.runs()[before]).toMatch(/^s2 /);
    expect(firstReason(o.stdout().slice(from))).toMatch(reason("sentinel.ts"));
    const afterSentinel = o.mark();
    const runs = o.runs().length;
    o.child.stdin!.write("\n");
    await o.waitFor(/\[oxnode\] Enter, restarting\n/, 20_000, afterSentinel);
    await o.waitFor(runLine("s2"), 20_000, afterSentinel);
    expect(o.runs()).toHaveLength(runs + 1);
  });

  test("piped stdin reaches the app, and oxnode does not read it", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `process.stdin.setEncoding("utf8").on("data", (d) => console.log("IN", JSON.stringify(d)));
console.log("RUN", "ready", process.pid);
`,
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("ready"));
    o.child.stdin!.write("hello\n");
    await o.waitFor(/^IN "hello\\n"\n/m);
    // A bare Return also goes to the app: oxnode reads a pipe only with --rerun-on-enter.
    o.child.stdin!.write("\n");
    await o.waitFor(/^IN "\\n"\n/m);
    expect(o.stdout()).not.toContain("Enter");
    expect(o.runs()).toHaveLength(1);
  });

  test("no screen clear when stdout is a pipe, even with --clear-screen", async () => {
    const root = project({ "package.json": ESM, "main.ts": MAIN, "dep.ts": value("v1") });
    const o = startOxnode(["watch", "--clear-screen=true", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"));
    expect(o.stdout()).not.toContain("\x1Bc");
  });
});

// Windows has no graceful stop: oxnode ends the app's tree at once.
describe.skipIf(EMULATED || !POSIX)("stopping the app", () => {
  test("a restart lets the app's SIGTERM handler finish first", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { v } from "./dep.js";
process.on("SIGTERM", () => setTimeout(() => { console.log("cleaned", v); process.exit(0); }, 200));
console.log("RUN", v, process.pid);
${KEEP}`,
      "dep.ts": value("v1"),
    });
    const o = startOxnode(["watch", "main.ts"], root);
    await o.waitFor(runLine("v1"));
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), runLine("v2"));
    expect(o.stdout()).toMatch(/^cleaned v1\n[\s\S]*^RUN v2 /m);
    expect(o.stdout()).not.toContain("force killing");
  });

  test("--kill-timeout=300 force kills an app that ignores SIGTERM, and its child", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `import { spawn } from "node:child_process";
import { v } from "./dep.js";
process.on("SIGTERM", () => console.log("ignored", v));
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("RUN", v, process.pid, grandchild.pid);
${KEEP}`,
      "dep.ts": value("v1"),
    });
    const o = startOxnode(["watch", "--kill-timeout=300", "main.ts"], root);
    const [, app, grandchild] = await o.waitFor(/^RUN v1 (\d+) (\d+)\n/m);
    await o.watched(join(root, "dep.ts"));
    await o.editUntil(join(root, "dep.ts"), () => value("v2"), /^RUN v2 \d+ \d+\n/m);
    expect(o.stdout()).toContain("ignored v1");
    expect(o.stdout()).toContain("[oxnode] still running after 300ms, force killing");
    expect(await isGone(Number(app)), "the app").toBe(true);
    expect(await isGone(Number(grandchild)), "the app's child").toBe(true);
  });

  test("SIGTERM to oxnode reaches the app, and oxnode exits with its code", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `process.on("SIGTERM", () => { console.log("GOT SIGTERM"); setTimeout(() => process.exit(3), 100); });
console.log("RUN", "up", process.pid);
${KEEP}`,
    });
    const o = startOxnode(["watch", "main.ts"], root);
    const [, app] = await o.waitFor(/^RUN up (\d+)\n/m);
    process.kill(o.child.pid!, "SIGTERM");
    expect(await o.exited).toEqual({ code: 3, signal: null });
    expect(count(o.stdout(), /GOT SIGTERM/)).toBe(1);
    expect(await isGone(Number(app)), "the app").toBe(true);
    expect(await isGone(o.child.pid!), "oxnode").toBe(true);
  });

  test("Ctrl+C: the app gets one SIGINT, and oxnode exits 0", async () => {
    const root = project({
      "package.json": ESM,
      "main.ts": `process.on("SIGINT", () => { console.log("GOT SIGINT"); setTimeout(() => process.exit(0), 300); });
console.log("RUN", "up", process.pid);
${KEEP}`,
    });
    const o = startOxnode(["watch", "main.ts"], root);
    const [, app] = await o.waitFor(/^RUN up (\d+)\n/m);
    process.kill(-o.child.pid!, "SIGINT");
    expect(await o.exited).toEqual({ code: 0, signal: null });
    expect(count(o.stdout(), /GOT SIGINT/)).toBe(1);
    expect(await isGone(Number(app)), "the app").toBe(true);
  });
});

function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first restart or rerun reason in `text`, with its line end. */
function firstReason(text: string): string {
  return text.match(/\[oxnode\] (?:change in .+|Enter), (?:restarting|rerunning)\n/)?.[0] ?? "";
}
