import { constants } from "node:os";
import { describe, expect, test } from "vitest";

import { exitPlan, SignalGate, usesNodeWatch } from "../../cli/src/run.js";

const gate = (o: { nodeWatch?: boolean; platform?: NodeJS.Platform; terminal?: boolean } = {}) =>
  new SignalGate({
    nodeWatch: o.nodeWatch ?? false,
    platform: o.platform ?? "linux",
    terminal: o.terminal,
  });

describe("SignalGate", () => {
  test("SIGINT waits 50 ms, then forwards when no ack came (kill -INT to oxnode alone)", () => {
    const g = gate();
    expect(g.onSignal("SIGINT", 1000)).toEqual({ action: "wait", ms: 50 });
    expect(g.onWaitExpired()).toEqual({ action: "forward", as: "SIGINT" });
  });

  test("an ack during the wait cancels it (Ctrl+C, the app saw it first)", () => {
    const g = gate();
    expect(g.onSignal("SIGINT", 1000)).toEqual({ action: "wait", ms: 50 });
    g.onAck(1010);
    expect(g.onWaitExpired()).toEqual({ action: "skip" });
  });

  test("a recent ack skips at once", () => {
    const g = gate();
    g.onAck(1000);
    expect(g.onSignal("SIGINT", 1080)).toEqual({ action: "skip" });
  });

  test("an old ack does not count", () => {
    const g = gate();
    g.onAck(1000);
    expect(g.onSignal("SIGINT", 1200)).toEqual({ action: "wait", ms: 50 });
  });

  test("the same signal within 500 ms is merged (npm forwards it too)", () => {
    const g = gate();
    expect(g.onSignal("SIGTERM", 1000)).toEqual({ action: "forward", as: "SIGTERM" });
    expect(g.onSignal("SIGTERM", 1100)).toEqual({ action: "skip" });
    expect(g.onSignal("SIGTERM", 1700)).toEqual({ action: "forward", as: "SIGTERM" });
    expect(g.onSignal("SIGINT", 1000)).toEqual({ action: "wait", ms: 50 });
    expect(g.onSignal("SIGINT", 1002)).toEqual({ action: "skip" });
    expect(g.onWaitExpired()).toEqual({ action: "forward", as: "SIGINT" });
  });

  test("SIGHUP goes to Node.js' watcher as SIGTERM", () => {
    expect(gate({ nodeWatch: true }).onSignal("SIGHUP", 0)).toEqual({
      action: "forward",
      as: "SIGTERM",
    });
    expect(gate().onSignal("SIGHUP", 0)).toEqual({ action: "forward", as: "SIGHUP" });
    expect(gate({ nodeWatch: true }).onSignal("SIGTERM", 0)).toEqual({
      action: "forward",
      as: "SIGTERM",
    });
  });

  test("in the terminal's foreground, SIGINT is never forwarded: Ctrl+C reached the child too", () => {
    const g = gate({ terminal: true });
    expect(g.onSignal("SIGINT", 1000)).toEqual({ action: "skip" });
    expect(g.onWaitExpired()).toEqual({ action: "skip" });
    expect(g.onSignal("SIGTERM", 1000)).toEqual({ action: "forward", as: "SIGTERM" });
  });

  test("win32 never forwards", () => {
    const g = gate({ platform: "win32" });
    for (const sig of ["SIGINT", "SIGBREAK", "SIGHUP"] as NodeJS.Signals[]) {
      expect(g.onSignal(sig, 0)).toEqual({ action: "skip" });
    }
  });

  test("a wait that already ended does not forward twice", () => {
    const g = gate();
    g.onSignal("SIGINT", 0);
    expect(g.onWaitExpired()).toEqual({ action: "forward", as: "SIGINT" });
    expect(g.onWaitExpired()).toEqual({ action: "skip" });
  });
});

describe("exitPlan", () => {
  test("an exit code passes through", () => {
    expect(exitPlan(0, null, "linux")).toEqual({ code: 0 });
    expect(exitPlan(42, null, "linux")).toEqual({ code: 42 });
    expect(exitPlan(null, null, "linux")).toEqual({ code: 1 });
  });

  test.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as NodeJS.Signals[])(
    "%s is raised again",
    (sig) => {
      expect(exitPlan(null, sig, "linux")).toEqual({ raise: sig });
      expect(exitPlan(null, sig, "darwin")).toEqual({ raise: sig });
    },
  );

  // Windows' `os.constants.signals` has no SIGBUS, SIGTRAP, SIGSYS, SIGXCPU or SIGXFSZ.
  test.each(
    [
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
    ].filter((sig) => sig in constants.signals) as NodeJS.Signals[],
  )("%s gives 128+n instead of a core dump", (sig) => {
    expect(exitPlan(null, sig, "linux")).toEqual({ code: 128 + constants.signals[sig] });
  });

  test("win32 never raises", () => {
    expect(exitPlan(null, "SIGTERM", "win32")).toEqual({ code: 128 + constants.signals.SIGTERM });
    expect(exitPlan(3221225786, null, "win32")).toEqual({ code: 3221225786 });
  });
});

describe("usesNodeWatch", () => {
  test.each([
    [["--watch", "app.ts"], true],
    [["--watch=true", "app.ts"], true],
    [["--watch-path", "src", "app.ts"], true],
    [["--watch-path=src", "app.ts"], true],
    [["--watch_path=src", "app.ts"], true],
    [["--import", "x", "--watch", "app.ts"], true],
    [["--inspect", "--watch", "app.ts"], true],
    // Value flags the parser does not list.
    [["--unhandled-rejections", "strict", "--watch", "app.ts"], true],
    [["--cpu-prof-dir", "d", "--watch", "app.ts"], true],
    // An app arg: SIGTERM ends the app just as SIGHUP would.
    [["app.ts", "--watch"], true],
    [["--", "app.ts", "--watch"], false],
    // The last flag wins, as in Node.js.
    [["--watch", "--no-watch", "app.ts"], false],
    [["--watch-path=src", "--no_watch", "app.ts"], false],
    [["--no-watch", "--watch", "app.ts"], true],
    // After another word, a --no-watch may be the app's: watch mode may still be on.
    [["--watch", "app.ts", "--no-watch"], true],
    [["--watch", "--title", "x", "--no-watch", "app.ts"], true],
    [["--watch-preserve-output", "app.ts"], false],
    [["--watch-kill-signal", "SIGINT", "app.ts"], false],
    [["--watchful", "app.ts"], false],
    [[], false],
  ])("%j → %s", (args, expected) => {
    expect(usesNodeWatch(args, {})).toBe(expected);
  });

  test("watch mode from NODE_OPTIONS, an env file or the config file", () => {
    const files: Record<string, string> = {
      "on.json": JSON.stringify({ nodeOptions: { watch: true } }),
      "off.json": "{}",
      "watch.env": "NODE_OPTIONS=--watch\n",
      "no.env": "NODE_OPTIONS=--no-watch\n",
    };
    const uses = (args: string[], env: NodeJS.ProcessEnv = {}, version = "26.12.0") =>
      usesNodeWatch(args, env, (f) => files[f], version);
    expect(uses(["app.ts"], { NODE_OPTIONS: "--watch" })).toBe(true);
    expect(uses(["app.ts"], { NODE_OPTIONS: "--watch --no-watch" })).toBe(false);
    expect(uses(["--env-file=watch.env", "app.ts"])).toBe(true);
    expect(uses(["--env-file", "watch.env", "app.ts"])).toBe(true);
    expect(uses(["--experimental-config-file=on.json", "app.ts"])).toBe(true);
    expect(uses(["--experimental-config-file=off.json", "app.ts"])).toBe(false);
    // Node.js 22 takes the next word as the config file.
    expect(uses(["--experimental-config-file", "on.json", "app.ts"], {}, "22.18.0")).toBe(true);
    // The same order as `oxnode watch`: the env file beats the config file from 24.16.
    expect(uses(["--env-file=no.env", "--experimental-config-file=on.json", "app.ts"])).toBe(false);
    expect(
      uses(["--env-file=no.env", "--experimental-config-file=on.json", "app.ts"], {}, "24.15.0"),
    ).toBe(true);
    // A flag on the command line beats them all.
    expect(uses(["--no-watch", "--experimental-config-file=on.json", "app.ts"])).toBe(false);
    expect(uses(["app.ts"], {})).toBe(false);
    // Before 26.12 a config flag after `--` counts as well; an env file there does not.
    expect(uses(["--", "app.ts", "--experimental-config-file=on.json"], {}, "24.22.0")).toBe(true);
    expect(uses(["--", "app.ts", "--experimental-config-file=on.json"], {}, "26.12.0")).toBe(false);
    expect(uses(["--", "app.ts", "--env-file=watch.env"])).toBe(false);
  });
});
