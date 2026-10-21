import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createSignalAck, FORWARDED, gateSignals, SignalGate, sigintFromTerminal } from "../run.js";
import { nestedWatcher, parseWatchArgs, tsconfigEnv } from "./args.js";
import { DirWatcher } from "./dirs.js";
import { makeMatcher, type Matcher, type Source } from "./glob.js";
import { help, namesFor, usage } from "./help.js";
import { killTree } from "./kill-tree.js";
import { createLog, debug } from "./log.js";
import { step, type Effect, type Event, type State } from "./machine.js";
import { fromOxcNode, parseWatchMessage } from "./messages.js";

const isBareReturn = (chunk: string) => /[\r\n]/.test(chunk) && chunk.replace(/[\r\n]/g, "") === "";

export interface WatchOptions {
  /**
   * The Node.js flags that load the app's hooks, put before the user's Node.js options:
   * `node <loaderArgs> <node options> <entry> <script args>`.
   * Default: `["--enable-source-maps", "--import", "@oxc-node/core/register" as a URL]`.
   */
  loaderArgs?: string[];
  /**
   * Folders of the loader's own files, which show up in the module graph but are never
   * watched. Each folder's real path counts too. Default: the folder of
   * `@oxc-node/core/register` when `loaderArgs` is not given, else none.
   */
  ignoreDirs?: string[];
  /**
   * The command as the user types it, in errors, the usage line and `--help`. Its first
   * word tags the log lines. Default: `"oxnode watch"`.
   */
  name?: string;
}

/**
 * Run the watcher until it stops, and resolve with the exit code. Until then it owns
 * SIGINT, SIGTERM and SIGHUP, stdin (for Return) and the process's IPC channel.
 */
export function runWatch(argv: string[], options: WatchOptions = {}): Promise<number> {
  const names = namesFor(options.name);
  const log = createLog(names.label);
  const args = parseWatchArgs(argv, process.env, undefined, undefined, names);
  if ("error" in args) {
    process.stderr.write(
      `${names.name}: ${args.error}\n${usage(names)}\nRun "${names.name} --help" for the options.\n`,
    );
    return Promise.resolve(1);
  }
  if (args.help) {
    process.stdout.write(help(names));
    return Promise.resolve(0);
  }

  const cwd = process.cwd();
  let { loaderArgs, ignoreDirs: given = [] } = options;
  if (!loaderArgs) {
    const registerURL = import.meta.resolve("@oxc-node/core/register");
    loaderArgs = [`--enable-source-maps`, `--import`, registerURL];
    // oxc-node's own files show up in the module graph.
    if (!options.ignoreDirs) given = [path.dirname(fileURLToPath(registerURL))];
  }
  const ignoreDirs: string[] = [];
  for (const dir of given) {
    ignoreDirs.push(dir);
    try {
      const real = realpathSync.native(dir);
      if (real !== dir) ignoreDirs.push(real);
    } catch {}
  }
  let matcher: Matcher;
  try {
    matcher = makeMatcher({
      cwd,
      include: args.include,
      exclude: args.exclude,
      platform: process.platform,
      ignoreDirs,
    });
  } catch (error) {
    process.stderr.write(`${names.name}: ${(error as Error).message}\n`);
    return Promise.resolve(1);
  }
  for (const note of args.notes) log(note);

  return new Promise((resolve) => {
    const ack = createSignalAck();
    let child: ChildProcess | undefined;
    // The last child started, still set after it exits: its reports may come after its exit.
    let latest: ChildProcess | undefined;
    const signals = gateSignals(
      new SignalGate({
        nodeWatch: false,
        platform: process.platform,
        terminal: sigintFromTerminal,
      }),
      ack,
      (sig) => child?.kill(sig),
      debug,
    );
    // Reading stdin from the background would stop oxnode (SIGTTIN).
    const enter = args.rerunOnEnter ?? sigintFromTerminal();
    const cfg = {
      killSignal: args.killSignal,
      killTimeout: args.killTimeout,
      clear: args.clearScreen && Boolean(process.stdout.isTTY),
      enter,
    };
    const env = {
      ...process.env,
      WATCH_REPORT_DEPENDENCIES: "1",
      ...ack.env,
      ...tsconfigEnv(args.tsconfig, cwd),
    };
    const nodeArgs = [...loaderArgs, ...args.nodeArgs];
    const timers = new Map<"debounce" | "kill", NodeJS.Timeout>();
    let state: State = { k: "idle" };

    const display = (p: string) => {
      const rel = path.relative(cwd, p);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `.${path.sep}${rel}` : p;
    };

    // A file can be wanted under two spellings, the path Node.js reported and its real
    // path: a symlink, or on Windows an 8.3 name such as `RUNNER~1`. One save then
    // fires for both, so a change to the real path is shown, and counted, as the other.
    const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const reported = new Map<string, string>();
    // What the current run's imports added, dropped before the next run, as Node.js does.
    const runAliases = new Set<string>();

    const watcher = new DirWatcher({
      poll: args.poll,
      platform: process.platform,
      matcher,
      onChange: (p) =>
        dispatch({ t: "change", path: display(reported.get(fold(p)) ?? p), now: Date.now() }),
      debug,
      warn: log,
    });

    const seen = new Set<string>();
    const runSeen = new Set<string>();
    const want = (p: string, source: Source) => {
      // An oxc-node report counts on its own: a package file Node.js reported (and the
      // default ignores skip) can be a tsconfig.json oxc-node reads later.
      const key = source === "oxc" ? `oxc:${p}` : p;
      if (seen.has(p) || runSeen.has(key)) return;
      const run = source === "graph" || source === "oxc";
      (run ? runSeen : seen).add(key);
      const verdict = matcher.classify(p, source);
      if (verdict === "watch") watcher.add(p, run, source === "oxc");
      else debug(`skip ${p} (${verdict === "exclude" ? "exclude" : "default"})`);
      if (verdict === "exclude") return;
      // Node.js reports real paths, but not under --preserve-symlinks, where a linked
      // workspace package shows up under node_modules and its real path must still count.
      try {
        const real = realpathSync.native(p);
        if (real !== p) {
          if (!reported.has(fold(real))) {
            reported.set(fold(real), p);
            if (run) runAliases.add(fold(real));
          }
          // A given link: the watcher follows it, and drops its old target when it moves.
          if (source === "literal" && lstatSync(p).isSymbolicLink()) return;
          want(real, source);
        }
      } catch {}
    };
    const newRun = () => {
      runSeen.clear();
      for (const k of runAliases) reported.delete(k);
      runAliases.clear();
      watcher.dropRun();
    };

    const spawnChild = () => {
      // An env file edited since the last start may now hold NODE_OPTIONS=--watch.
      const nested = nestedWatcher(args, process.env);
      if (nested) {
        // After this step's other effects, as for a spawn that fails.
        queueMicrotask(() => dispatch({ t: "spawnError", err: nested }));
        return;
      }
      newRun();
      const c = spawn(process.execPath, nodeArgs, {
        env,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        windowsHide: false,
      });
      child = c;
      latest = c;
      c.on("message", (msg) => {
        const paths = parseWatchMessage(msg);
        if (paths) {
          // A late report from the run before must not add back what the new run dropped.
          const source = fromOxcNode(msg) ? "oxc" : "graph";
          if (c === latest) for (const p of paths) want(p, source);
        } else if (process.send && process.connected) {
          // Like Node.js' watcher, pass the app's own messages on.
          process.send(msg as never, () => {});
        }
      });
      c.on("error", (error) => {
        if (c.pid === undefined && child === c) {
          child = undefined;
          dispatch({ t: "spawnError", err: error.message });
        }
      });
      c.on("exit", (code, signal) => {
        if (child !== c) return;
        child = undefined;
        dispatch({ t: "childExit", code, signal });
      });
      if (c.pid !== undefined) debug(`spawn ${c.pid}`);
    };

    const run = (e: Effect) => {
      switch (e.e) {
        case "spawn":
          spawnChild();
          break;
        case "kill":
          // On Windows `kill()` is TerminateProcess anyway, and it leaves the grandchildren.
          if (child && process.platform === "win32") killTree(child);
          else child?.kill(e.sig as NodeJS.Signals);
          break;
        case "killTree":
          if (child) killTree(child);
          break;
        case "clearScreen":
          process.stdout.write("\x1Bc");
          break;
        case "log":
          log(e.msg);
          break;
        case "startTimer": {
          clearTimeout(timers.get(e.id));
          const ev: Event = e.id === "debounce" ? { t: "debounceFired" } : { t: "killTimeout" };
          timers.set(
            e.id,
            setTimeout(() => {
              timers.delete(e.id);
              dispatch(ev);
            }, e.ms),
          );
          break;
        }
        case "clearTimer":
          clearTimeout(timers.get(e.id));
          timers.delete(e.id);
          break;
        case "forwardSignal":
          signals.signal(e.sig);
          break;
        case "exit":
          finish(e.code);
          break;
      }
    };

    function dispatch(ev: Event) {
      const r = step(state, ev, cfg);
      state = r.state;
      for (const e of r.effects) run(e);
    }

    const onSignal = (sig: NodeJS.Signals) => dispatch({ t: "signal", sig, now: Date.now() });
    const onParentMessage = (msg: unknown) => {
      if (child?.connected) child.send(msg as never, () => {});
    };

    // Only a bare Return reruns. Line mode keeps echo, editing and Ctrl+C with the terminal.
    let reading = false;
    const onData = (chunk: string) => {
      if (isBareReturn(chunk)) dispatch({ t: "enter" });
    };
    const stopReading = () => {
      if (!reading) return;
      reading = false;
      process.stdin.off("data", onData).off("end", stopReading).off("error", stopReading);
      process.stdin.pause();
      process.stdin.unref?.();
    };

    function finish(code: number) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      signals.dispose();
      ack.close();
      watcher.close();
      stopReading();
      for (const sig of FORWARDED) process.off(sig, onSignal);
      process.off("message", onParentMessage);
      resolve(code);
    }

    for (const sig of FORWARDED) process.on(sig, onSignal);
    if (process.send) process.on("message", onParentMessage);
    if (enter) {
      reading = true;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", onData).on("end", stopReading).on("error", stopReading);
    }

    want(path.resolve(cwd, args.entry), "literal");
    for (const file of args.envFiles) want(path.resolve(cwd, file), "literal");
    // Node.js does not watch these, but a fixed or edited one should apply.
    for (const file of args.configFiles) want(path.resolve(cwd, file), "literal");
    if (args.tsconfig) want(path.resolve(cwd, args.tsconfig), "literal");
    for (const file of matcher.literals()) want(file, "literal");
    for (const root of matcher.roots()) watcher.addRoot(root.base, root.depth);

    dispatch({ t: "start" });
  });
}
