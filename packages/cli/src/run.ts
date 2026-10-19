import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { isatty } from "node:tty";

import { nestedWatcher, nodeFiles } from "./watch/args.js";

/** The signals oxnode passes on to the app. On Windows it only listens, so it outlives the app. */
export const FORWARDED: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];

// Re-raising these would make oxnode dump core as well.
const CORE_SIGNALS = new Set([
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGFPE",
  "SIGILL",
  "SIGQUIT",
  "SIGTRAP",
  "SIGSYS",
  "SIGXCPU",
  "SIGXFSZ",
]);

export type ExitPlan = { raise: NodeJS.Signals } | { code: number };

/** How oxnode ends so that its own status matches the child's. */
export function exitPlan(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): ExitPlan {
  if (signal && platform !== "win32" && !CORE_SIGNALS.has(signal)) {
    return { raise: signal };
  }
  return { code: signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1) };
}

export function exitLike(code: number | null, signal: NodeJS.Signals | null): never {
  const plan = exitPlan(code, signal);
  if ("raise" in plan) {
    for (const s of FORWARDED) {
      process.removeAllListeners(s);
    }
    process.kill(process.pid, plan.raise);
    // Ref'd, in case the signal does not end the process.
    setTimeout(() => process.exit(128 + os.constants.signals[plan.raise]), 100);
    return undefined as never;
  }
  process.exit(plan.code);
}

export interface SignalAck {
  env: Record<string, string>;
  onAck(cb: () => void): void;
  close(): void;
}

/**
 * A unix socket the child writes "I" to when the terminal already sent it SIGINT
 * (`@oxc-node/core/signal-ack.mjs`), so oxnode does not send it a second one.
 */
export function createSignalAck(): SignalAck {
  const callbacks: (() => void)[] = [];
  const none: SignalAck = {
    env: {},
    onAck: () => {},
    close: () => {},
  };
  if (process.platform === "win32") {
    return none;
  }
  const path = join(os.tmpdir(), `oxnode-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  // sun_path is 104 bytes on macOS and 108 on Linux.
  if (Buffer.byteLength(path) > 100) {
    return none;
  }
  const server = createServer((socket) => {
    socket.unref();
    socket.on("error", () => {});
    socket.on("data", (data) => {
      for (const byte of data) {
        if (byte === 0x49 /* I */) {
          for (const cb of callbacks) cb();
        }
      }
    });
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.off("exit", close);
    process.off("SIGQUIT", onQuit);
    server.close();
    try {
      unlinkSync(path);
    } catch {}
  };
  // A listen error leaves the child unable to connect: every SIGINT is then forwarded.
  server.on("error", close);
  try {
    server.listen(path);
  } catch {
    return none;
  }
  server.unref();
  process.on("exit", close);
  // Ctrl+\ ends oxnode with no 'exit' event: remove the socket, then die by SIGQUIT as before.
  // Nothing can do this for SIGKILL.
  function onQuit() {
    close();
    process.kill(process.pid, "SIGQUIT");
  }
  process.once("SIGQUIT", onQuit);
  return {
    env: { OXNODE_SIGNAL_ACK: path },
    onAck: (cb) => void callbacks.push(cb),
    close,
  };
}

/** Whether oxnode is in the terminal's foreground group: reading stdin from the background stops it (SIGTTIN). */
export function isForeground(): boolean {
  try {
    if (process.platform === "win32") return true;
    if (process.platform === "linux") {
      const stat = readFileSync("/proc/self/stat", "utf8");
      // After the name: state, ppid, pgrp, session, tty_nr, tpgid
      const f = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      return f[2] === f[5];
    }
    const [pgid, tpgid] = execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/);
    return pgid === tpgid;
  } catch {
    return false;
  }
}

/**
 * Whether a SIGINT oxnode gets comes from the terminal's Ctrl+C, which signals the whole
 * foreground group, the child included. Ask it once the SIGINT is in: a Ctrl+C during the
 * check also kills the `ps` it runs on macOS, and the answer would be false.
 */
export const sigintFromTerminal = (): boolean => isatty(0) && isForeground();

export type GateAction =
  | { action: "skip" }
  | { action: "forward"; as: NodeJS.Signals }
  | { action: "wait"; ms: number };

/** Decides whether a signal oxnode got goes on to the child. Pure: the caller owns the timers. */
export class SignalGate {
  #nodeWatch: boolean;
  #platform: NodeJS.Platform;
  #terminal: () => boolean;
  #waitMs: number;
  #recentMs: number;
  #coalesceMs: number;
  #last = new Map<NodeJS.Signals, number>();
  #lastAck = -Infinity;
  #waiting = false;

  constructor(o: {
    nodeWatch: boolean;
    platform: NodeJS.Platform;
    /** See `sigintFromTerminal`. A function is called for each SIGINT. */
    terminal?: boolean | (() => boolean);
    waitMs?: number;
    recentMs?: number;
    coalesceMs?: number;
  }) {
    this.#nodeWatch = o.nodeWatch;
    this.#platform = o.platform;
    const terminal = o.terminal ?? false;
    this.#terminal = typeof terminal === "function" ? terminal : () => terminal;
    this.#waitMs = o.waitMs ?? 50;
    this.#recentMs = o.recentMs ?? 100;
    this.#coalesceMs = o.coalesceMs ?? 500;
  }

  onSignal(sig: NodeJS.Signals, now: number): GateAction {
    // The console already told the child, and `kill()` there is a hard kill.
    if (this.#platform === "win32") {
      return { action: "skip" };
    }
    const prev = this.#last.get(sig);
    this.#last.set(sig, now);
    // npm forwards the SIGINT the terminal already sent to the whole group.
    if (prev !== undefined && now - prev < this.#coalesceMs) {
      return { action: "skip" };
    }
    if (sig === "SIGINT") {
      // The child has it already. The ack cannot tell: it comes late, or never (a REPL eval),
      // when the child's event loop is busy. `kill -INT` to oxnode alone is then not passed on.
      if (this.#terminal()) {
        return { action: "skip" };
      }
      if (now - this.#lastAck <= this.#recentMs) {
        return { action: "skip" };
      }
      this.#waiting = true;
      return { action: "wait", ms: this.#waitMs };
    }
    // Node's watcher ignores SIGHUP and would keep its app running.
    if (sig === "SIGHUP" && this.#nodeWatch) {
      return { action: "forward", as: "SIGTERM" };
    }
    return { action: "forward", as: sig };
  }

  onAck(now: number): void {
    this.#lastAck = now;
    this.#waiting = false;
  }

  onWaitExpired(): GateAction {
    if (!this.#waiting) {
      return { action: "skip" };
    }
    this.#waiting = false;
    return { action: "forward", as: "SIGINT" };
  }
}

/** Runs `onSignal` decisions against a child, including the SIGINT wait. */
export function gateSignals(
  gate: SignalGate,
  ack: SignalAck,
  kill: (sig: NodeJS.Signals) => void,
  debug: (line: string) => void = () => {},
): { signal(sig: NodeJS.Signals): void; dispose(): void } {
  let timer: NodeJS.Timeout | undefined;
  const act = (r: GateAction) => {
    if (r.action === "forward") {
      debug(`forward ${r.as}`);
      kill(r.as);
    } else if (r.action === "wait") {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        act(gate.onWaitExpired());
      }, r.ms);
    }
  };
  ack.onAck(() => {
    debug("ack");
    gate.onAck(Date.now());
    clearTimeout(timer);
    timer = undefined;
  });
  return {
    signal: (sig) => act(gate.onSignal(sig, Date.now())),
    dispose: () => clearTimeout(timer),
  };
}

/** Spawns the child, passes signals on through the gate, and exits the way the child did. */
export function runChild(cmd: string, args: string[], o: { nodeWatch: boolean }): void {
  // Listen first: a Ctrl+C that finds no listener ends oxnode at once and takes the
  // terminal from the child. A listener runs on a later tick, once `gate` is set.
  let gate: ReturnType<typeof gateSignals> | undefined;
  for (const sig of FORWARDED) {
    process.on(sig, (s: NodeJS.Signals) => gate?.signal(s));
  }
  const ack = createSignalAck();
  const child = spawn(cmd, args, {
    env: { ...process.env, ...ack.env },
    stdio: "inherit",
  });
  gate = gateSignals(
    new SignalGate({
      nodeWatch: o.nodeWatch,
      platform: process.platform,
      terminal: sigintFromTerminal,
    }),
    ack,
    (sig) => {
      child.kill(sig);
    },
  );
  child.on("error", (error) => {
    console.error(error);
    // Only a failed spawn ends oxnode; a failed kill leaves the child to exit on its own.
    if (child.pid === undefined) {
      gate?.dispose();
      ack.close();
      process.exit(1);
    }
  });
  child.on("exit", (code, signal) => {
    gate?.dispose();
    ack.close();
    exitLike(code, signal);
  });
}

/**
 * True when Node.js' own watch mode may be on. Every arg is checked, as finding the entry
 * needs every Node.js flag that takes a value (`--unhandled-rejections strict`). An app arg
 * named `--watch` only turns SIGHUP into SIGTERM, which ends the app as well. The last flag
 * wins, as in Node.js, but a `--no-watch` after any other word may be the app's, so it does not
 * turn watch mode off. With no flag, NODE_OPTIONS (from the env or an env file) and the config
 * file decide, as `oxnode watch` reads them.
 */
export function usesNodeWatch(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  read?: (file: string) => string | undefined,
  nodeVersion?: string,
): boolean {
  let on: boolean | undefined;
  let word = false;
  for (const arg of args) {
    if (arg === "--") {
      break;
    }
    if (/^--watch([-_]path)?(=|$)/.test(arg)) {
      on = true;
    } else if (/^--no[-_]watch$/.test(arg)) {
      if (!word) on = false;
    } else if (!arg.startsWith("-")) {
      word = true;
    }
  }
  if (on !== undefined) return on;
  const files = { ...nodeFiles(args, nodeVersion), noWatch: false };
  return nestedWatcher(files, env, read, nodeVersion) !== undefined;
}
