import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";

import { NODE_VALUE_FLAGS } from "./watch/args.js";

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
  path?: string;
  env: Record<string, string>;
  lastAckAt(): number;
  onAck(cb: () => void): void;
  close(): void;
}

/**
 * A unix socket the child writes "I" to when the terminal already sent it SIGINT
 * (`@oxc-node/core/signal-ack.mjs`), so oxnode does not send it a second one.
 */
export function createSignalAck(): SignalAck {
  let lastAt = -Infinity;
  const callbacks: (() => void)[] = [];
  const none: SignalAck = {
    env: {},
    lastAckAt: () => lastAt,
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
          lastAt = Date.now();
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
  return {
    path,
    env: { OXNODE_SIGNAL_ACK: path },
    lastAckAt: () => lastAt,
    onAck: (cb) => void callbacks.push(cb),
    close,
  };
}

export type GateAction =
  | { action: "skip" }
  | { action: "forward"; as: NodeJS.Signals }
  | { action: "wait"; ms: number };

/** Decides whether a signal oxnode got goes on to the child. Pure: the caller owns the timers. */
export class SignalGate {
  #nodeWatch: boolean;
  #platform: NodeJS.Platform;
  #waitMs: number;
  #recentMs: number;
  #coalesceMs: number;
  #last = new Map<NodeJS.Signals, number>();
  #lastAck = -Infinity;
  #waiting = false;

  constructor(o: {
    nodeWatch: boolean;
    platform: NodeJS.Platform;
    waitMs?: number;
    recentMs?: number;
    coalesceMs?: number;
  }) {
    this.#nodeWatch = o.nodeWatch;
    this.#platform = o.platform;
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
  const ack = createSignalAck();
  const child = spawn(cmd, args, {
    env: { ...process.env, ...ack.env },
    stdio: "inherit",
  });
  const gate = gateSignals(
    new SignalGate({ nodeWatch: o.nodeWatch, platform: process.platform }),
    ack,
    (sig) => {
      child.kill(sig);
    },
  );
  for (const sig of FORWARDED) {
    process.on(sig, (s: NodeJS.Signals) => gate.signal(s));
  }
  child.on("error", (error) => {
    console.error(error);
    // Only a failed spawn ends oxnode; a failed kill leaves the child to exit on its own.
    if (child.pid === undefined) {
      gate.dispose();
      ack.close();
      process.exit(1);
    }
  });
  child.on("exit", (code, signal) => {
    gate.dispose();
    ack.close();
    exitLike(code, signal);
  });
}

/** True when Node.js' own watch mode is asked for before the entry. */
export function usesNodeWatch(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--" || !arg.startsWith("-") || arg === "-") {
      return false;
    }
    if (/^--watch(-path)?(=|$)/.test(arg)) {
      return true;
    }
    if (NODE_VALUE_FLAGS.has(arg)) {
      i++;
    }
  }
  return false;
}
