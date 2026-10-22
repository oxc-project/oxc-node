/**
 * The restart lifecycle of `oxnode watch`, as a pure reducer. The caller runs the effects
 * (spawn, kill, timers, output) and feeds back what happens as events.
 */

interface Debounce {
  firstAt: number;
  paths: string[];
}

export type State =
  | { k: "idle"; debounce?: Debounce }
  | { k: "running"; debounce?: Debounce }
  | {
      k: "stopping";
      after: "restart" | "exit";
      firstSig?: NodeJS.Signals;
      firstSigAt?: number;
    }
  | { k: "done" };

export type Event =
  | { t: "start" }
  | { t: "change"; path: string; now: number }
  | { t: "debounceFired" }
  | { t: "enter" }
  /** The app exited. After a rerun stopped it, what it had started is gone too: command.ts waits for that. */
  | { t: "childExit"; code: number | null; signal: string | null }
  | { t: "killTimeout" }
  | { t: "signal"; sig: NodeJS.Signals; now: number }
  | { t: "spawnError"; err: string };

export type Effect =
  | { e: "spawn" }
  | { e: "kill"; sig: string }
  | { e: "killTree" }
  | { e: "clearScreen" }
  | { e: "log"; msg: string }
  | { e: "startTimer"; id: "debounce" | "kill"; ms: number }
  | { e: "clearTimer"; id: "debounce" | "kill" }
  | { e: "forwardSignal"; sig: NodeJS.Signals }
  | { e: "exit"; code: number };

export interface MachineConfig {
  killSignal: string;
  killTimeout: number;
  clear: boolean;
  /** Whether Return reruns, for the hint in the messages. */
  enter?: boolean;
}

export const DEBOUNCE_MS = 100;
export const DEBOUNCE_CAP_MS = 500;
/** A second SIGINT counts as a second press only after this long; sooner, it is npm forwarding. */
export const SECOND_PRESS_MS = 500;

const ms = (n: number) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`);

function exitReason(code: number | null, signal: string | null): string {
  if (signal) return `killed by ${signal}`;
  return code ? `exited with code ${code}` : "completed";
}

function trigger(
  s: State,
  reason: string,
  cfg: MachineConfig,
): { state: State; effects: Effect[] } {
  const clear: Effect[] = cfg.clear ? [{ e: "clearScreen" }] : [];
  if (s.k === "idle") {
    return {
      state: { k: "running" },
      effects: [...clear, { e: "log", msg: `${reason}, rerunning` }, { e: "spawn" }],
    };
  }
  // running
  const effects: Effect[] = [...clear, { e: "log", msg: `${reason}, restarting` }];
  if (cfg.killTimeout === 0) {
    effects.push({ e: "killTree" });
  } else {
    effects.push(
      { e: "kill", sig: cfg.killSignal },
      { e: "startTimer", id: "kill", ms: cfg.killTimeout },
    );
  }
  return { state: { k: "stopping", after: "restart" }, effects };
}

export function step(s: State, ev: Event, cfg: MachineConfig): { state: State; effects: Effect[] } {
  const same = { state: s, effects: [] as Effect[] };
  const hint = cfg.enter ? " (Enter to rerun)" : "";
  if (s.k === "done") return same;

  if (ev.t === "spawnError") {
    return {
      state: { k: "done" },
      effects: [
        { e: "clearTimer", id: "kill" },
        { e: "log", msg: `cannot start: ${ev.err}` },
        { e: "exit", code: 1 },
      ],
    };
  }

  switch (s.k) {
    case "idle":
    case "running":
      switch (ev.t) {
        case "start":
          if (s.k !== "idle") return same;
          return {
            state: { k: "running" },
            effects: [{ e: "log", msg: `watching for changes${hint}` }, { e: "spawn" }],
          };
        case "change": {
          const db = s.debounce;
          if (!db) {
            return {
              state: { ...s, debounce: { firstAt: ev.now, paths: [ev.path] } },
              effects: [{ e: "startTimer", id: "debounce", ms: DEBOUNCE_MS }],
            };
          }
          const paths = db.paths.includes(ev.path) ? db.paths : [...db.paths, ev.path];
          const left = Math.max(0, DEBOUNCE_CAP_MS - (ev.now - db.firstAt));
          return {
            state: { ...s, debounce: { firstAt: db.firstAt, paths } },
            effects: [{ e: "startTimer", id: "debounce", ms: Math.min(DEBOUNCE_MS, left) }],
          };
        }
        case "debounceFired": {
          const db = s.debounce;
          if (!db) return same;
          const more = db.paths.length > 1 ? ` (+${db.paths.length - 1} more)` : "";
          return trigger(s, `change in ${db.paths[0]}${more}`, cfg);
        }
        case "enter": {
          const r = trigger(s, "Enter", cfg);
          return s.debounce
            ? { ...r, effects: [{ e: "clearTimer", id: "debounce" }, ...r.effects] }
            : r;
        }
        case "childExit": {
          if (s.k !== "running") return same;
          const lastExit = exitReason(ev.code, ev.signal);
          return {
            state: { k: "idle", debounce: s.debounce },
            effects: [{ e: "log", msg: `${lastExit} — waiting for changes${hint}` }],
          };
        }
        case "signal":
          if (s.k === "idle") return { state: { k: "done" }, effects: [{ e: "exit", code: 0 }] };
          return {
            state: { k: "stopping", after: "exit", firstSig: ev.sig, firstSigAt: ev.now },
            effects: [
              { e: "clearTimer", id: "debounce" },
              { e: "forwardSignal", sig: ev.sig },
              { e: "startTimer", id: "kill", ms: cfg.killTimeout },
            ],
          };
        default:
          return same;
      }

    case "stopping":
      switch (ev.t) {
        case "change":
          // Merged: the next run loads the new files anyway.
          return same;
        case "enter":
          return { state: s, effects: [{ e: "log", msg: "force killing" }, { e: "killTree" }] };
        case "killTimeout":
          return {
            state: s,
            effects: [
              { e: "log", msg: `still running after ${ms(cfg.killTimeout)}, force killing` },
              { e: "killTree" },
            ],
          };
        case "childExit":
          if (s.after === "restart") {
            return {
              state: { k: "running" },
              effects: [{ e: "clearTimer", id: "kill" }, { e: "spawn" }],
            };
          }
          return {
            state: { k: "done" },
            effects: [
              { e: "clearTimer", id: "kill" },
              { e: "exit", code: ev.code ?? 0 },
            ],
          };
        case "signal": {
          if (s.after === "restart") {
            return {
              state: { ...s, after: "exit", firstSig: ev.sig, firstSigAt: ev.now },
              effects: [{ e: "forwardSignal", sig: ev.sig }],
            };
          }
          const since = ev.now - (s.firstSigAt ?? ev.now);
          if (ev.sig === "SIGINT" && since > SECOND_PRESS_MS) {
            return { state: s, effects: [{ e: "log", msg: "force killing" }, { e: "killTree" }] };
          }
          // The same signal again within the window is npm forwarding what the group already got.
          if (ev.sig === s.firstSig && since <= SECOND_PRESS_MS) return same;
          return { state: s, effects: [{ e: "forwardSignal", sig: ev.sig }] };
        }
        default:
          return same;
      }
  }
}
