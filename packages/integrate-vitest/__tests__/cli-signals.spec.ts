import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, test } from "vitest";

import { descendants, parsePs } from "../../cli/src/watch/kill-tree.js";

/**
 * Plain runs: oxnode passes signals on to the app once and exits the way the app did.
 * A process group stands in for the terminal: `process.kill(-pid)` is what Ctrl+C does.
 */
const CLI = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));
// The child side of the SIGINT ack (OXNODE_SIGNAL_ACK). Without it, Ctrl+C reaches an app
// that has its own SIGINT listener twice: from the terminal, and from oxnode 50 ms later.
const HAS_ACK = existsSync(join(CORE, "signal-ack.mjs"));
const posix = process.platform !== "win32";

const env = {
  ...process.env,
  NODE_OPTIONS: undefined,
  OXC_LOG: undefined,
  OXNODE_SIGNAL_ACK: undefined,
  WATCH_REPORT_DEPENDENCIES: undefined,
  // oxnode runs `node` from PATH: make it the one running the tests.
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "oxc-node-signals-")));
writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
symlinkSync(CORE, join(root, "node_modules", "@oxc-node", "core"), posix ? "dir" : "junction");

const READY = `console.log("READY", process.pid);\nsetInterval(() => {}, 1000);\n`;

const apps: Record<string, string> = {
  "exit-code.ts": `const code: number = 7;\nprocess.exit(code);\n`,
  "self-kill.ts": `process.kill(process.pid, "SIGKILL");\nsetInterval(() => {}, 1000);\n`,
  // Each signal is logged, then the app cleans up and exits.
  "handler.ts": `for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    console.log("GOT", sig);
    setTimeout(() => { console.log("cleaned"); process.exit(0); }, 300);
  });
}
${READY}`,
  "cleanup-7.ts": `process.on("SIGINT", () => {
  console.log("GOT SIGINT");
  setTimeout(() => { console.log("cleaned"); process.exit(7); }, 300);
});
${READY}`,
  // signal-exit: when its listener is the only one, it removes itself and re-raises.
  "signal-exit.ts": `const onSig = () => {
  console.log("GOT SIGINT");
  if (process.listeners("SIGINT").length === 1) {
    process.removeListener("SIGINT", onSig);
    process.kill(process.pid, "SIGINT");
  }
};
process.on("SIGINT", onSig);
console.log("COUNT", process.listenerCount("SIGINT"));
${READY}`,
  "no-listener.ts": READY,
};
for (const [name, source] of Object.entries(apps)) writeFileSync(join(root, name), source);

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Run {
  child: ChildProcess;
  out(): string;
  waitFor(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const started: Run[] = [];

function oxnode(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
  // A new group, so a group signal reaches oxnode and the app, as Ctrl+C does.
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    detached: posix,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const waiters = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    out += chunk;
    for (const w of waiters) w();
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const run: Run = {
    child,
    out: () => out,
    exited,
    waitFor: (re, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const m = out.match(re);
          if (!m) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(m);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for ${re}; output:\n${out}`));
        }, ms);
        waiters.add(check);
        check();
      }),
  };
  started.push(run);
  return run;
}

afterEach(async () => {
  for (const run of started.splice(0)) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) continue;
    try {
      if (posix) process.kill(-run.child.pid!, "SIGKILL");
      else run.child.kill();
    } catch {}
    await run.exited;
  }
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function isGone(pid: number) {
  const until = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

/** oxnode's process tree, taken before it is stopped. */
const tree = (pid: number) =>
  descendants(parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })), pid);

const count = (text: string, re: RegExp) => text.match(new RegExp(re, "g"))?.length ?? 0;

test("the exit code passes through", async () => {
  const run = oxnode(["exit-code.ts"]);
  expect(await run.exited).toEqual({ code: 7, signal: null });
});

test("no node on PATH exits 1", () => {
  const r = spawnSync(process.execPath, [CLI, "exit-code.ts"], {
    cwd: root,
    env: { ...env, PATH: "" },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toMatch(/ENOENT/);
});

describe.skipIf(!posix)("signals", () => {
  test("an app that SIGKILLs itself: oxnode ends by SIGKILL", async () => {
    const run = oxnode(["self-kill.ts"]);
    expect(await run.exited).toEqual({ code: null, signal: "SIGKILL" });
  });

  test.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)(
    "%s to oxnode alone reaches the app once",
    async (sig) => {
      const run = oxnode(["handler.ts"]);
      const [, pid] = await run.waitFor(/READY (\d+)/);
      process.kill(run.child.pid!, sig);
      expect(await run.exited).toEqual({ code: 0, signal: null });
      expect(count(run.out(), /GOT /)).toBe(1);
      expect(run.out()).toContain(`GOT ${sig}`);
      expect(run.out()).toContain("cleaned");
      expect(await isGone(Number(pid))).toBe(true);
    },
  );

  // Needs the child side of the ack in @oxc-node/core (signal-ack.mjs).
  test.skipIf(!HAS_ACK)(
    "Ctrl+C: the app gets one SIGINT, and oxnode waits for its cleanup",
    async () => {
      const run = oxnode(["cleanup-7.ts"]);
      await run.waitFor(/READY/);
      process.kill(-run.child.pid!, "SIGINT");
      expect(await run.exited).toEqual({ code: 7, signal: null });
      expect(count(run.out(), /GOT SIGINT/)).toBe(1);
      expect(run.out()).toMatch(/GOT SIGINT[\s\S]*cleaned/);
    },
  );

  // Needs the child side of the ack in @oxc-node/core (signal-ack.mjs).
  test.skipIf(!HAS_ACK)("npm: Ctrl+C plus a forwarded SIGINT still gives one", async () => {
    const run = oxnode(["cleanup-7.ts"]);
    await run.waitFor(/READY/);
    process.kill(-run.child.pid!, "SIGINT");
    process.kill(run.child.pid!, "SIGINT");
    expect(await run.exited).toEqual({ code: 7, signal: null });
    expect(count(run.out(), /GOT SIGINT/)).toBe(1);
  });

  test("Ctrl+C: oxnode exits after the app's cleanup, with its code", async () => {
    const run = oxnode(["cleanup-7.ts"]);
    await run.waitFor(/READY/);
    process.kill(-run.child.pid!, "SIGINT");
    // Until the ack lands, the app may see SIGINT twice; what counts here is that oxnode waits.
    expect(await run.exited).toEqual({ code: 7, signal: null });
    expect(run.out()).toContain("cleaned");
  });

  test("a signal-exit style app still dies by SIGINT, and sees one listener", async () => {
    const run = oxnode(["signal-exit.ts"]);
    await run.waitFor(/READY/);
    expect(run.out()).toContain("COUNT 1");
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toEqual({ code: null, signal: "SIGINT" });
  });

  test("an app with no listener: oxnode ends by SIGINT", async () => {
    const run = oxnode(["no-listener.ts"]);
    await run.waitFor(/READY/);
    process.kill(-run.child.pid!, "SIGINT");
    expect(await run.exited).toEqual({ code: null, signal: "SIGINT" });
  });

  test.each([
    ["SIGTERM to oxnode", (pid: number) => process.kill(pid, "SIGTERM")],
    ["SIGHUP to oxnode", (pid: number) => process.kill(pid, "SIGHUP")],
    ["Ctrl+C", (pid: number) => process.kill(-pid, "SIGINT")],
  ])("oxnode --watch + %s leaves nothing running", async (_name, send) => {
    const run = oxnode(["--watch", "no-listener.ts"]);
    const [, appPid] = await run.waitFor(/READY (\d+)/);
    const pids = tree(run.child.pid!);
    expect(pids).toContain(Number(appPid));
    send(run.child.pid!);
    await run.exited;
    for (const pid of pids) expect(await isGone(pid), `pid ${pid}`).toBe(true);
  });
});
