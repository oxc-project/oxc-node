import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared by the end-to-end watch specs: they run the built CLI against a
 * project in a temp folder, edit its files and wait for the app to run again.
 * Nothing here sleeps for a fixed time; every wait is for a line of output.
 */
export const CLI = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
const CORE = dirname(fileURLToPath(new URL("../../../core/register.mjs", import.meta.url)));
const CLI_PACKAGE = fileURLToPath(new URL("../../../cli", import.meta.url));
export const MAJOR = Number(process.versions.node.split(".")[0]);
export const POSIX = process.platform !== "win32";
/** These run under QEMU in CI, where file events and timers are too slow to time. */
export const EMULATED = ["s390x", "ppc64", "arm"].includes(process.arch);

/** How long `editUntil` waits for the result of one write before writing again. */
const REWRITE_MS = 750;

const roots: string[] = [];

/**
 * A project in a fresh temp folder, by its real path (Node.js reports real
 * paths, and macOS keeps tmp under a link), with `@oxc-node/core` linked in, and
 * `@oxc-node/cli` too with `linkCli`.
 */
export function project(files: Record<string, string>, opts: { linkCli?: boolean } = {}): string {
  // `.native` also expands a Windows 8.3 name (CI's temp folder is under `RUNNER~1`), so the
  // paths the tests expect are the ones Node.js reports.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "oxc-node-watch-e2e-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    write(join(root, name), contents);
  }
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  const links = opts.linkCli ? { core: CORE, cli: CLI_PACKAGE } : { core: CORE };
  for (const [name, target] of Object.entries(links)) {
    symlinkSync(
      target,
      join(root, "node_modules", "@oxc-node", name),
      // `junction` is the only link type Windows allows without elevated privileges.
      POSIX ? "dir" : "junction",
    );
  }
  return root;
}

/** For `afterAll`, after `stopAll`: Windows cannot remove a folder that is still watched. */
export function removeProjects(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Writes a file, creating its folders. */
export function write(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** Saves the way many editors do: write a temp file, then rename it over the target. */
export function atomicWrite(file: string, contents: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, file);
}

/** The test runner's environment without anything that changes how oxnode or oxc-node behave. */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Plain runs and `oxnode --watch` run `node` from PATH: make it the one running the tests.
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    NO_COLOR: "1",
  };
  for (const key of [
    "NODE_OPTIONS",
    "OXC_LOG",
    "WATCH_REPORT_DEPENDENCIES",
    "OXC_TSCONFIG_PATH",
    "TS_NODE_PROJECT",
    "OXNODE_SIGNAL_ACK",
    "OXNODE_WATCH_DEBUG",
    "FORCE_COLOR",
    "CHOKIDAR_USEPOLLING",
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason line for a change to one file, written relative to the project. */
export function reason(name: string, then: "restarting" | "rerunning" = "restarting"): RegExp {
  const rel = name.split("/").map(escape).join("[\\\\/]");
  // `, restarting` right after the name: one file, not `(+1 more)`.
  return new RegExp(`\\[oxnode\\] change in \\.[\\\\/]${rel}, ${then}\\n`);
}

export interface Oxnode {
  child: ChildProcess;
  /** The app's and oxnode's output (both write to the same stdout). */
  stdout(): string;
  /** OXNODE_WATCH_DEBUG lines and the app's errors. */
  stderr(): string;
  /** Where stdout ends now, to look only at what comes after. */
  mark(): number;
  /** The text after `RUN ` of every complete line the app printed, in order. */
  runs(): string[];
  /** Waits for `re` in stdout after `from`. */
  waitFor(re: RegExp, ms?: number, from?: number): Promise<RegExpMatchArray>;
  /** Waits for `re` in stderr. */
  waitDebug(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  /** Waits until oxnode watches `file` (`watch <file>`) and, without --poll, its folder is ready. */
  watched(file: string, opts?: { poll?: boolean }): Promise<void>;
  /**
   * Writes `content(0)`, then `content(1)`, … every 750 ms until `re` shows in
   * stdout, up to 20 s, and stops writing once a write brings a restart. A write
   * that lands while a new folder watch is still starting can be missed
   * (FSEvents), and the next one is not.
   */
  editUntil(
    file: string,
    content: (attempt: number) => string,
    re: RegExp,
    save?: (file: string, contents: string) => void,
  ): Promise<RegExpMatchArray>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const started: Oxnode[] = [];

/**
 * Runs the built CLI (or `opts.script`) with `args`. On POSIX it gets a process group of its own,
 * so `process.kill(-pid, sig)` stands in for the terminal (Ctrl+C), and `stop`
 * can sweep up anything the app left behind.
 */
export function startOxnode(
  args: string[],
  cwd: string,
  opts: { debug?: boolean; env?: NodeJS.ProcessEnv; script?: string } = {},
): Oxnode {
  const child = spawn(process.execPath, [opts.script ?? CLI, ...args], {
    cwd,
    env: cleanEnv({ ...(opts.debug === false ? {} : { OXNODE_WATCH_DEBUG: "1" }), ...opts.env }),
    detached: POSIX,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // The app may exit before a test writes to its stdin.
  child.stdin!.on("error", () => {});
  const buffers = { stdout: "", stderr: "" };
  const waiters = new Set<() => void>();
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]!.setEncoding("utf8");
    child[stream]!.on("data", (chunk: string) => {
      buffers[stream] += chunk;
      for (const check of waiters) check();
    });
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );

  const wait = (
    stream: "stdout" | "stderr",
    re: RegExp,
    ms: number,
    from: number,
  ): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const m = buffers[stream].slice(from).match(re);
        if (!m) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(m);
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(
            `timed out waiting for ${re} in ${stream}\n--- stdout:\n${buffers.stdout}\n--- stderr:\n${buffers.stderr}`,
          ),
        );
      }, ms);
      waiters.add(check);
      check();
    });

  const o: Oxnode = {
    child,
    exited,
    stdout: () => buffers.stdout,
    stderr: () => buffers.stderr,
    mark: () => buffers.stdout.length,
    runs: () =>
      buffers.stdout
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.startsWith("RUN "))
        .map((line) => line.slice(4)),
    waitFor: (re, ms = 20_000, from = 0) => wait("stdout", re, ms, from),
    waitDebug: (re, ms = 20_000) => wait("stderr", re, ms, 0),
    async watched(file, { poll = false } = {}) {
      await wait("stderr", new RegExp(`^watch ${escape(file)}$`, "m"), 20_000, 0);
      if (poll) return;
      let dir = dirname(file);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      await wait("stderr", new RegExp(`^ready ${escape(dir)}$`, "m"), 20_000, 0);
    },
    async editUntil(file, content, re, save = write) {
      const from = buffers.stdout.length;
      const until = Date.now() + 20_000;
      for (let attempt = 0; ; attempt++) {
        const at = buffers.stdout.length;
        save(file, content(attempt));
        try {
          return await wait("stdout", re, REWRITE_MS, from);
        } catch (error) {
          if (Date.now() >= until) throw error;
          // The write was seen: the app is only slow to start (a worker, a slow runner). Writing
          // again would restart it before it prints, again and again.
          if (/\[[\w-]+\] change in /.test(buffers.stdout.slice(at))) {
            return await wait("stdout", re, until - Date.now(), from);
          }
        }
      }
    },
  };
  started.push(o);
  return o;
}

const done = (o: Oxnode) => o.child.exitCode !== null || o.child.signalCode !== null;

/**
 * SIGTERM, up to 5 s for oxnode to exit, then SIGKILL to its whole group (or
 * `taskkill /T /F`), which also ends anything the app left running.
 */
export async function stop(o: Oxnode): Promise<void> {
  const pid = o.child.pid;
  if (pid === undefined) return;
  if (POSIX) {
    if (!done(o)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      await Promise.race([o.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  } else if (!done(o)) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  await o.exited;
}

/** For `afterEach`. */
export async function stopAll(): Promise<void> {
  await Promise.all(started.splice(0).map(stop));
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `pid` is gone, up to 5 s. */
export async function isGone(pid: number): Promise<boolean> {
  const until = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}
