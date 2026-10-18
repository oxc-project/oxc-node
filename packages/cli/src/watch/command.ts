import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Command, Option, type Usage } from "clipanion";

import { createSignalAck, FORWARDED, gateSignals, SignalGate, sigintFromTerminal } from "../run.js";
import { parseWatchArgs, tsconfigEnv } from "./args.js";
import { DirWatcher } from "./dirs.js";
import { makeMatcher, type Matcher, type Source } from "./glob.js";
import { HELP, USAGE } from "./help.js";
import { killTree } from "./kill-tree.js";
import { debug, log } from "./log.js";
import { step, type Effect, type Event, type State } from "./machine.js";
import { parseWatchMessage } from "./messages.js";

export class WatchCommand extends Command {
  static paths = [[`watch`]];

  static usage: Usage = {
    description: `Run a script and run it again when a file it uses changes`,
    details: `Run \`oxnode watch --help\` for the options.`,
    examples: [[`Watch mode`, `oxnode watch ./src/index.ts`]],
  };

  // Everything, `--help` included, goes to the watch parser.
  args = Option.Proxy();

  async execute() {
    return runWatch(this.args);
  }
}

const isBareReturn = (chunk: string) => /[\r\n]/.test(chunk) && chunk.replace(/[\r\n]/g, "") === "";

export function runWatch(argv: string[]): Promise<number> {
  const args = parseWatchArgs(argv, process.env);
  if ("error" in args) {
    process.stderr.write(
      `oxnode watch: ${args.error}\n${USAGE}\nRun "oxnode watch --help" for the options.\n`,
    );
    return Promise.resolve(1);
  }
  if (args.help) {
    process.stdout.write(HELP);
    return Promise.resolve(0);
  }

  const cwd = process.cwd();
  const registerURL = import.meta.resolve("@oxc-node/core/register");
  // oxc-node's own files show up in the module graph.
  const ignoreDirs = [path.dirname(fileURLToPath(registerURL))];
  try {
    const real = realpathSync.native(ignoreDirs[0]);
    if (real !== ignoreDirs[0]) ignoreDirs.push(real);
  } catch {}
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
    process.stderr.write(`oxnode watch: ${(error as Error).message}\n`);
    return Promise.resolve(1);
  }
  for (const note of args.notes) log(note);

  return new Promise((resolve) => {
    const ack = createSignalAck();
    let child: ChildProcess | undefined;
    const fromTerminal = sigintFromTerminal();
    const signals = gateSignals(
      new SignalGate({ nodeWatch: false, platform: process.platform, terminal: fromTerminal }),
      ack,
      (sig) => child?.kill(sig),
      debug,
    );
    const enter = args.rerunOnEnter ?? fromTerminal;
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
    const nodeArgs = [`--enable-source-maps`, `--import`, registerURL, ...args.nodeArgs];
    const timers = new Map<"debounce" | "kill", NodeJS.Timeout>();
    let state: State = { k: "idle" };

    const display = (p: string) => {
      const rel = path.relative(cwd, p);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `.${path.sep}${rel}` : p;
    };

    const watcher = new DirWatcher({
      poll: args.poll,
      platform: process.platform,
      matcher,
      onChange: (p) => dispatch({ t: "change", path: display(p), now: Date.now() }),
      debug,
      warn: log,
    });

    const seen = new Set<string>();
    const want = (p: string, source: Source) => {
      if (seen.has(p)) return;
      seen.add(p);
      const verdict = matcher.classify(p, source);
      if (verdict !== "watch") {
        debug(`skip ${p} (${verdict === "exclude" ? "exclude" : "default"})`);
        return;
      }
      watcher.add(p);
      // Node.js reports real paths, but not under --preserve-symlinks.
      try {
        const real = realpathSync.native(p);
        if (real !== p) want(real, source);
      } catch {}
    };

    const spawnChild = () => {
      const c = spawn(process.execPath, nodeArgs, {
        env,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        windowsHide: false,
      });
      child = c;
      c.on("message", (msg) => {
        const paths = parseWatchMessage(msg);
        if (paths) {
          for (const p of paths) want(p, "graph");
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
    if (args.tsconfig) want(path.resolve(cwd, args.tsconfig), "literal");
    for (const file of matcher.literals()) want(file, "literal");
    for (const root of matcher.roots()) watcher.addRoot(root.base, root.depth);

    dispatch({ t: "start" });
  });
}
