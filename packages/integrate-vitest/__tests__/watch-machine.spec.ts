import { describe, expect, test } from "vitest";

import { step, type Effect, type Event, type State } from "../../cli/src/watch/machine.js";

const cfg = { killSignal: "SIGTERM", killTimeout: 5000, clear: true, enter: true };

/** Feeds events in order and returns the final state plus every effect. */
function run(events: Event[], from: State = { k: "idle" }, c = cfg) {
  let state = from;
  const effects: Effect[] = [];
  for (const ev of events) {
    const r = step(state, ev, c);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const running = (): State => ({ k: "running" });
const stopping = (after: "restart" | "exit", firstSigAt?: number): State => ({
  k: "stopping",
  after,
  forced: false,
  pending: false,
  ...(firstSigAt === undefined ? {} : { firstSig: "SIGINT" as const, firstSigAt }),
});
const count = (effects: Effect[], e: Effect["e"]) => effects.filter((x) => x.e === e).length;

describe("step", () => {
  test("start spawns once and says it is watching", () => {
    expect(step({ k: "idle" }, { t: "start" }, cfg)).toEqual({
      state: { k: "running" },
      effects: [{ e: "log", msg: "watching for changes (Enter to rerun)" }, { e: "spawn" }],
    });
    expect(step({ k: "idle" }, { t: "start" }, { ...cfg, enter: false }).effects[0]).toEqual({
      e: "log",
      msg: "watching for changes",
    });
  });

  test("idle + trigger: clear, reason, spawn", () => {
    expect(run([{ t: "enter" }])).toEqual({
      state: { k: "running" },
      effects: [{ e: "clearScreen" }, { e: "log", msg: "Enter, rerunning" }, { e: "spawn" }],
    });
    expect(run([{ t: "enter" }], { k: "idle" }, { ...cfg, clear: false }).effects).toEqual([
      { e: "log", msg: "Enter, rerunning" },
      { e: "spawn" },
    ]);
  });

  test("running + trigger: clear, reason, kill, kill timer", () => {
    const r = run([{ t: "change", path: "./a.ts", now: 0 }, { t: "debounceFired" }], running());
    expect(r.state).toEqual(stopping("restart"));
    expect(r.effects).toEqual([
      { e: "startTimer", id: "debounce", ms: 100 },
      { e: "clearScreen" },
      { e: "log", msg: "change in ./a.ts, restarting" },
      { e: "kill", sig: "SIGTERM" },
      { e: "startTimer", id: "kill", ms: 5000 },
    ]);
  });

  test("running + trigger with killTimeout 0 kills the tree at once", () => {
    const r = run([{ t: "enter" }], running(), { ...cfg, killTimeout: 0 });
    expect(r.state).toMatchObject({ k: "stopping", after: "restart", forced: true });
    expect(r.effects.slice(-1)).toEqual([{ e: "killTree" }]);
    expect(count(r.effects, "kill")).toBe(0);
  });

  test("running + childExit: idle, with the reason", () => {
    expect(run([{ t: "childExit", code: 0, signal: null }], running()).effects).toEqual([
      { e: "log", msg: "completed — waiting for changes (Enter to rerun)" },
    ]);
    expect(run([{ t: "childExit", code: 1, signal: null }], running())).toEqual({
      state: { k: "idle", lastExit: "exited with code 1", debounce: undefined },
      effects: [{ e: "log", msg: "exited with code 1 — waiting for changes (Enter to rerun)" }],
    });
    expect(run([{ t: "childExit", code: null, signal: "SIGSEGV" }], running()).effects).toEqual([
      { e: "log", msg: "killed by SIGSEGV — waiting for changes (Enter to rerun)" },
    ]);
  });

  test("crash, then a fix reruns from idle", () => {
    const r = run([
      { t: "start" },
      { t: "childExit", code: 1, signal: null },
      { t: "change", path: "./a.ts", now: 1000 },
      { t: "debounceFired" },
    ]);
    expect(r.state).toEqual({ k: "running" });
    expect(r.effects.slice(-3)).toEqual([
      { e: "clearScreen" },
      { e: "log", msg: "change in ./a.ts, rerunning" },
      { e: "spawn" },
    ]);
  });

  test("debounce merges changes and names the first", () => {
    const r = run(
      [
        { t: "change", path: "./a.ts", now: 0 },
        { t: "change", path: "./b.ts", now: 30 },
        { t: "change", path: "./a.ts", now: 60 },
        { t: "change", path: "./c.ts", now: 90 },
        { t: "debounceFired" },
      ],
      running(),
    );
    expect(r.effects.filter((e) => e.e === "startTimer" && e.id === "debounce")).toHaveLength(4);
    expect(r.effects).toContainEqual({ e: "log", msg: "change in ./a.ts (+2 more), restarting" });
  });

  test("debounce is capped at 500 ms after the first change", () => {
    const events: Event[] = [];
    for (let now = 0; now <= 480; now += 40) events.push({ t: "change", path: "./a.ts", now });
    const timers = run(events, running()).effects.flatMap((e) =>
      e.e === "startTimer" && e.id === "debounce" ? [e.ms] : [],
    );
    expect(timers[0]).toBe(100);
    // At 400 ms the next timer is the time left until 500 ms.
    expect(timers.at(-3)).toBe(100); // now = 400
    expect(timers.at(-2)).toBe(60); // now = 440
    expect(timers.at(-1)).toBe(20); // now = 480
  });

  test("a stale debounceFired does nothing", () => {
    expect(run([{ t: "debounceFired" }], running())).toEqual({ state: running(), effects: [] });
  });

  test("Enter skips the debounce", () => {
    const r = run([{ t: "change", path: "./a.ts", now: 0 }, { t: "enter" }], running());
    expect(r.effects).toEqual([
      { e: "startTimer", id: "debounce", ms: 100 },
      { e: "clearTimer", id: "debounce" },
      { e: "clearScreen" },
      { e: "log", msg: "Enter, restarting" },
      { e: "kill", sig: "SIGTERM" },
      { e: "startTimer", id: "kill", ms: 5000 },
    ]);
  });

  test("3 changes while stopping give 1 spawn and no second clear", () => {
    const r = run(
      [
        { t: "change", path: "./a.ts", now: 200 },
        { t: "change", path: "./b.ts", now: 210 },
        { t: "change", path: "./c.ts", now: 220 },
        { t: "childExit", code: null, signal: "SIGTERM" },
      ],
      stopping("restart"),
    );
    expect(r.state).toEqual({ k: "running" });
    expect(r.effects).toEqual([{ e: "clearTimer", id: "kill" }, { e: "spawn" }]);
  });

  test("stopping(restart) + change marks a pending restart", () => {
    expect(run([{ t: "change", path: "./a.ts", now: 0 }], stopping("restart")).state).toMatchObject(
      {
        pending: true,
      },
    );
  });

  test("Enter while stopping force kills", () => {
    for (const after of ["restart", "exit"] as const) {
      const r = run([{ t: "enter" }], stopping(after, after === "exit" ? 0 : undefined));
      expect(r.state).toMatchObject({ k: "stopping", after, forced: true });
      expect(r.effects).toEqual([{ e: "log", msg: "force killing" }, { e: "killTree" }]);
    }
  });

  test("the kill timeout force kills", () => {
    const r = run([{ t: "killTimeout" }], stopping("restart"));
    expect(r.state).toMatchObject({ forced: true });
    expect(r.effects).toEqual([
      { e: "log", msg: "still running after 5s, force killing" },
      { e: "killTree" },
    ]);
    expect(
      run([{ t: "killTimeout" }], stopping("restart"), { ...cfg, killTimeout: 300 }).effects[0],
    ).toEqual({ e: "log", msg: "still running after 300ms, force killing" });
  });

  test("a stale kill timeout does nothing", () => {
    expect(run([{ t: "killTimeout" }], running()).effects).toEqual([]);
    expect(run([{ t: "killTimeout" }], { k: "idle" }).effects).toEqual([]);
  });

  test("running + signal: forward it and start the kill timer", () => {
    const r = run([{ t: "signal", sig: "SIGINT", now: 1000 }], running());
    expect(r.state).toEqual({
      k: "stopping",
      after: "exit",
      forced: false,
      pending: false,
      firstSig: "SIGINT",
      firstSigAt: 1000,
    });
    expect(r.effects).toEqual([
      { e: "clearTimer", id: "debounce" },
      { e: "forwardSignal", sig: "SIGINT" },
      { e: "startTimer", id: "kill", ms: 5000 },
    ]);
  });

  test("stopping(restart) + signal becomes stopping(exit)", () => {
    const r = run([{ t: "signal", sig: "SIGTERM", now: 7 }], stopping("restart"));
    expect(r.state).toMatchObject({ after: "exit", firstSig: "SIGTERM", firstSigAt: 7 });
    expect(r.effects).toEqual([{ e: "forwardSignal", sig: "SIGTERM" }]);
  });

  test("npm's duplicate SIGINT within 500 ms is ignored", () => {
    const r = run(
      [
        { t: "signal", sig: "SIGINT", now: 1000 },
        { t: "signal", sig: "SIGINT", now: 1003 },
      ],
      running(),
    );
    expect(count(r.effects, "forwardSignal")).toBe(1);
    expect(count(r.effects, "killTree")).toBe(0);
    expect(r.state).toMatchObject({ forced: false });
  });

  test("a second press more than 500 ms later kills the tree", () => {
    const r = run(
      [
        { t: "signal", sig: "SIGINT", now: 1000 },
        { t: "signal", sig: "SIGINT", now: 1600 },
      ],
      running(),
    );
    expect(r.state).toMatchObject({ k: "stopping", after: "exit", forced: true });
    expect(r.effects.slice(-2)).toEqual([{ e: "log", msg: "force killing" }, { e: "killTree" }]);
  });

  test("a different signal is still forwarded", () => {
    const r = run(
      [
        { t: "signal", sig: "SIGINT", now: 1000 },
        { t: "signal", sig: "SIGTERM", now: 1100 },
      ],
      running(),
    );
    expect(r.effects.filter((e) => e.e === "forwardSignal")).toEqual([
      { e: "forwardSignal", sig: "SIGINT" },
      { e: "forwardSignal", sig: "SIGTERM" },
    ]);
  });

  test("exit codes after a user stop", () => {
    expect(run([{ t: "childExit", code: 7, signal: null }], stopping("exit", 0))).toEqual({
      state: { k: "done" },
      effects: [
        { e: "clearTimer", id: "kill" },
        { e: "exit", code: 7 },
      ],
    });
    // Killed by the signal: 0, as tsx and Node.js do, so npm prints no error.
    expect(
      run([{ t: "childExit", code: null, signal: "SIGINT" }], stopping("exit", 0)).effects,
    ).toContainEqual({
      e: "exit",
      code: 0,
    });
  });

  test("idle + signal exits 0", () => {
    expect(run([{ t: "signal", sig: "SIGINT", now: 0 }])).toEqual({
      state: { k: "done" },
      effects: [{ e: "exit", code: 0 }],
    });
  });

  test("a spawn error exits 1 from any state", () => {
    for (const from of [{ k: "idle" }, running(), stopping("restart")] as State[]) {
      const r = run([{ t: "spawnError", err: "spawn ENOENT" }], from);
      expect(r.state).toEqual({ k: "done" });
      expect(r.effects.slice(-2)).toEqual([
        { e: "log", msg: "cannot start: spawn ENOENT" },
        { e: "exit", code: 1 },
      ]);
    }
  });

  test("done ignores everything", () => {
    for (const ev of [
      { t: "start" },
      { t: "enter" },
      { t: "signal", sig: "SIGINT", now: 0 },
      { t: "childExit", code: 0, signal: null },
    ] as Event[]) {
      expect(step({ k: "done" }, ev, cfg)).toEqual({ state: { k: "done" }, effects: [] });
    }
  });
});
