import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { parseWatchArgs, tsconfigEnv, type WatchArgs } from "../../cli/src/watch/args.js";

const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseWatchArgs(argv, env);

function ok(argv: string[], env: NodeJS.ProcessEnv = {}): WatchArgs {
  const r = parse(argv, env);
  if ("error" in r) throw new Error(r.error);
  return r;
}

function err(argv: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = parse(argv, env);
  if (!("error" in r)) throw new Error(`expected an error for ${argv.join(" ")}`);
  return r.error;
}

describe("parseWatchArgs", () => {
  test("defaults", () => {
    expect(ok(["app.ts"])).toEqual({
      include: [],
      exclude: [],
      clearScreen: true,
      killSignal: "SIGTERM",
      killTimeout: 5000,
      rerunOnEnter: undefined,
      poll: false,
      help: false,
      nodeArgs: ["app.ts"],
      entry: "app.ts",
      envFiles: [],
      notes: [],
    });
  });

  test("a value with = or as the next token", () => {
    const a = ok(["--include=a/*.json", "--include", "b/**", "--kill-timeout=300", "app.ts"]);
    expect(a.include).toEqual(["a/*.json", "b/**"]);
    expect(a.killTimeout).toBe(300);
    expect(ok(["--kill-signal", "SIGINT", "app.ts"]).killSignal).toBe("SIGINT");
    expect(ok(["--exclude", "x.ts", "app.ts"]).exclude).toEqual(["x.ts"]);
  });

  test("boolean flags never take the next token", () => {
    const a = ok(["--clear-screen", "app.ts"]);
    expect(a.clearScreen).toBe(true);
    expect(a.entry).toBe("app.ts");
    expect(ok(["--rerun-on-enter", "app.ts"])).toMatchObject({
      rerunOnEnter: true,
      entry: "app.ts",
    });
    expect(ok(["--poll", "app.ts"])).toMatchObject({ poll: 300, entry: "app.ts" });
    expect(ok(["--clear-screen=false", "app.ts"]).clearScreen).toBe(false);
    expect(ok(["--no-clear-screen", "app.ts"]).clearScreen).toBe(false);
    expect(ok(["--rerun-on-enter=false", "app.ts"]).rerunOnEnter).toBe(false);
    expect(ok(["--no-rerun-on-enter", "app.ts"]).rerunOnEnter).toBe(false);
    expect(ok(["--poll=1000", "app.ts"]).poll).toBe(1000);
    expect(err(["--clear-screen=maybe", "app.ts"])).toMatch(/true or false/);
  });

  test("aliases", () => {
    expect(ok(["--ignore", "dist/**", "app.ts"]).exclude).toEqual(["dist/**"]);
    expect(ok(["--watch-preserve-output", "app.ts"]).clearScreen).toBe(false);
    expect(ok(["--watch-kill-signal=SIGINT", "app.ts"]).killSignal).toBe("SIGINT");
    expect(ok(["--watch_preserve_output", "app.ts"]).clearScreen).toBe(false);
    const u = ok(["--watch_kill_signal", "SIGUSR1", "app.ts"]);
    expect(u.killSignal).toBe("SIGUSR1");
    expect(u.nodeArgs).toEqual(["app.ts"]);
  });

  test("!x in --include is an exclude", () => {
    const a = ok(["--include", "src/**", "--include=!src/gen/**", "app.ts"]);
    expect(a.include).toEqual(["src/**"]);
    expect(a.exclude).toEqual(["src/gen/**"]);
  });

  test("--tsconfig maps to OXC_TSCONFIG_PATH and drops TS_NODE_PROJECT", () => {
    const a = ok(["--tsconfig", "tsconfig.dev.json", "app.ts"]);
    expect(a.tsconfig).toBe("tsconfig.dev.json");
    expect(a.nodeArgs).toEqual(["app.ts"]);
    expect(tsconfigEnv(a.tsconfig, "/proj")).toEqual({
      OXC_TSCONFIG_PATH: resolve("/proj", "tsconfig.dev.json"),
      TS_NODE_PROJECT: undefined,
    });
    expect(tsconfigEnv(undefined, "/proj")).toEqual({});
  });

  test("--no-cache is a no-op with a note", () => {
    const a = ok(["--no-cache", "app.ts"]);
    expect(a.notes).toEqual(["oxc-node has no transform cache"]);
    expect(a.nodeArgs).toEqual(["app.ts"]);
  });

  test("Node.js value flags keep their value in order", () => {
    const a = ok([
      "--import",
      "./setup.ts",
      "-r",
      "dotenv/config",
      "--conditions=dev",
      "--inspect",
      "--clear-screen=false",
      "app.ts",
    ]);
    expect(a.nodeArgs).toEqual([
      "--import",
      "./setup.ts",
      "-r",
      "dotenv/config",
      "--conditions=dev",
      "--inspect",
      "app.ts",
    ]);
    expect(a.entry).toBe("app.ts");
    expect(a.clearScreen).toBe(false);
  });

  test("a Node.js flag spelled with `_` is read as Node.js reads it", () => {
    const a = ok(["--env_file", ".env", "--openssl_config", "x.cnf", "app.ts"]);
    expect(a.entry).toBe("app.ts");
    expect(a.envFiles).toEqual([".env"]);
  });

  test("--include !(x)/... is a glob, --include !x an exclude", () => {
    const a = ok(["--include", "!(dist)/**/*.ts", "--include", "!gen/**", "app.ts"]);
    expect(a.include).toEqual(["!(dist)/**/*.ts"]);
    expect(a.exclude).toEqual(["gen/**"]);
  });

  test("a Node.js flag's value after a space is not the entry", () => {
    const a = ok(["--openssl-config", "openssl.cnf", "--max-http-header-size", "9000", "app.ts"]);
    expect(a.entry).toBe("app.ts");
    expect(ok(["--report-directory", "reports", "app.ts"]).entry).toBe("app.ts");
    expect(a.nodeArgs).toEqual([
      "--openssl-config",
      "openssl.cnf",
      "--max-http-header-size",
      "9000",
      "app.ts",
    ]);
  });

  test("an unknown Node.js flag with a space hides later watch flags but keeps the order", () => {
    const a = ok(["--stack-size", "2000", "--include", "x", "app.ts"]);
    // `2000` is taken for the entry: Node.js still sees `--stack-size 2000 --include x app.ts`.
    expect(a.entry).toBe("2000");
    expect(a.nodeArgs).toEqual(["--stack-size", "2000", "--include", "x", "app.ts"]);
  });

  test("-- ends the options", () => {
    const a = ok(["--include", "a", "--", "--weird.ts", "--include", "b"]);
    expect(a.entry).toBe("--weird.ts");
    expect(a.include).toEqual(["a"]);
    expect(a.nodeArgs).toEqual(["--", "--weird.ts", "--include", "b"]);
  });

  test("script args after the entry keep watch flags", () => {
    const a = ok(["app.ts", "--include", "x", "--port", "3000"]);
    expect(a.include).toEqual([]);
    expect(a.nodeArgs).toEqual(["app.ts", "--include", "x", "--port", "3000"]);
  });

  test.each([
    ["--watch", /use --include/],
    ["--watch-path=src", /use --include/],
    ["--watch_path=src", /use --include/],
    ["-e", /needs an entry file/],
    ["--eval=1", /needs an entry file/],
    ["-p", /needs an entry file/],
    ["--print", /needs an entry file/],
    ["-i", /needs an entry file/],
    ["--interactive", /needs an entry file/],
    ["--test", /oxnode --watch --test/],
    ["--run", /needs an entry file/],
    ["-", /needs an entry file/],
  ])("rejects %s", (flag, message) => {
    expect(err([flag, "app.ts"])).toMatch(message);
  });

  test("NODE_OPTIONS with --watch is an error", () => {
    expect(err(["app.ts"], { NODE_OPTIONS: "--max-old-space-size=100 --watch" })).toMatch(
      /nested watcher/,
    );
    expect(err(["app.ts"], { NODE_OPTIONS: "--watch-path=src" })).toMatch(/nested watcher/);
    expect(err(["app.ts"], { NODE_OPTIONS: "--watch_path=src" })).toMatch(/nested watcher/);
    expect(ok(["app.ts"], { NODE_OPTIONS: "--max-old-space-size=100" }).entry).toBe("app.ts");
  });

  test("--env-file values are recorded", () => {
    const a = ok(["--env-file", ".env", "--env-file-if-exists=.env.local", "app.ts"]);
    expect(a.envFiles).toEqual([".env", ".env.local"]);
    expect(a.nodeArgs).toEqual(["--env-file", ".env", "--env-file-if-exists=.env.local", "app.ts"]);
  });

  test("a missing entry is an error, unless --help is given", () => {
    expect(err([])).toMatch(/missing <entry>/);
    expect(err(["--include", "x"])).toMatch(/missing <entry>/);
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
  });

  test("bad values", () => {
    expect(err(["--kill-signal", "TERM", "app.ts"])).toMatch(/signal name/);
    expect(err(["--kill-timeout", "-1", "app.ts"])).toMatch(/whole number/);
    expect(err(["--kill-timeout=1.5", "app.ts"])).toMatch(/whole number/);
    expect(err(["--poll=fast", "app.ts"])).toMatch(/whole number/);
    expect(err(["--include"])).toMatch(/needs a glob/);
    expect(ok(["--kill-timeout", "0", "app.ts"]).killTimeout).toBe(0);
  });

  test("values a timer cannot take", () => {
    // setTimeout fires at once above 2^31 - 1 ms.
    expect(ok(["--kill-timeout=2147483647", "app.ts"]).killTimeout).toBe(2147483647);
    expect(err(["--kill-timeout=2147483648", "app.ts"])).toMatch(/at most 2147483647/);
    expect(err(["--kill-timeout", "99999999999", "app.ts"])).toMatch(/at most 2147483647/);
    // 0 would stat in a tight loop; the walk timer is 10 × the interval.
    expect(err(["--poll=0", "app.ts"])).toMatch(/--poll takes 1 to 214748364 ms/);
    expect(err(["--poll=214748365", "app.ts"])).toMatch(/--poll takes 1 to 214748364 ms/);
    expect(ok(["--poll=1", "app.ts"]).poll).toBe(1);
    expect(ok(["--poll=214748364", "app.ts"]).poll).toBe(214748364);
  });

  test("CHOKIDAR_USEPOLLING turns polling on", () => {
    expect(ok(["app.ts"], { CHOKIDAR_USEPOLLING: "1" }).poll).toBe(300);
    expect(ok(["app.ts"], { CHOKIDAR_USEPOLLING: "true" }).poll).toBe(300);
    expect(ok(["app.ts"], { CHOKIDAR_USEPOLLING: "0" }).poll).toBe(false);
  });
});
