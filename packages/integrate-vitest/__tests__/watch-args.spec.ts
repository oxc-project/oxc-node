import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  configFileNestedWatcher,
  nestedWatcher,
  nodeOptionsTokens,
  parseWatchArgs,
  tsconfigEnv,
  type WatchArgs,
} from "../../cli/src/watch/args.js";

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
      configFiles: [],
      noWatch: false,
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
    const u = ok(["--watch_kill_signal", "SIGINT", "app.ts"]);
    expect(u.killSignal).toBe("SIGINT");
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

  test("a Node.js config file that turns on watch mode is an error", () => {
    const files: Record<string, string> = {
      "on.json": JSON.stringify({ nodeOptions: { watch: true } }),
      "path.json": JSON.stringify({ nodeOptions: { "watch-path": "src" } }),
      // From Node.js 25.4, a `watch` section turns watch mode on by being there.
      "section.json": JSON.stringify({ watch: { "watch-preserve-output": true } }),
      "section-off.json": JSON.stringify({
        watch: { watch: false, "watch-preserve-output": true },
      }),
      "off.json": JSON.stringify({ nodeOptions: { watch: false, "watch-preserve-output": true } }),
      // The last key wins, as for flags.
      "path-then-off.json": JSON.stringify({ nodeOptions: { "watch-path": ".", watch: false } }),
      "off-then-path.json": JSON.stringify({ nodeOptions: { watch: false, "watch-path": "." } }),
      "versions.json": JSON.stringify({
        configs: [
          { nodeVersion: 25, config: { nodeOptions: { "watch-path": "src" } } },
          { nodeVersion: 26, config: { nodeOptions: { import: ["x"] } } },
        ],
      }),
      "node.config.json": JSON.stringify({ nodeOptions: { watch: true } }),
      "bad.json": "{",
    };
    const withFiles = (argv: string[], version = "26.12.0") =>
      parseWatchArgs(argv, {}, (f) => files[f], version);
    expect(withFiles(["--experimental-config-file=on.json", "app.ts"])).toEqual({
      error: expect.stringMatching(/config file on\.json turns on --watch/),
    });
    expect(withFiles(["--config-file=path.json", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--config-file=section.json", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--config-file=section.json", "app.ts"], "25.4.0")).toHaveProperty("error");
    expect(withFiles(["--config-file=section.json", "app.ts"], "24.22.0")).not.toHaveProperty(
      "error",
    );
    expect(withFiles(["--experimental-default-config-file", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--experimental_config_file=on.json", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--config-file=section-off.json", "app.ts"])).not.toHaveProperty("error");
    expect(withFiles(["--config-file=off.json", "app.ts"])).not.toHaveProperty("error");
    expect(withFiles(["--config-file=path-then-off.json", "app.ts"])).not.toHaveProperty("error");
    expect(withFiles(["--config-file=off-then-path.json", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--config-file=bad.json", "app.ts"])).not.toHaveProperty("error");
    expect(withFiles(["--config-file=missing.json", "app.ts"])).not.toHaveProperty("error");
    // `configs`: the entry for this major version.
    expect(withFiles(["--config-file=versions.json", "app.ts"], "26.12.0")).not.toHaveProperty(
      "error",
    );
    expect(withFiles(["--config-file=versions.json", "app.ts"], "25.9.0")).toHaveProperty("error");
    // Read again on each call: checked before every start.
    files["off.json"] = JSON.stringify({ nodeOptions: { watch: true } });
    expect(configFileNestedWatcher(["off.json"], (f) => files[f])).toMatch(/nested watcher/);
  });

  test("--no-watch beats a config file that turns watch mode on", () => {
    const files: Record<string, string> = {
      "on.json": JSON.stringify({ nodeOptions: { watch: true } }),
      ".env": "NODE_OPTIONS=--no-watch\n",
    };
    const read = (f: string) => files[f];
    const withEnv = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
      parseWatchArgs(argv, env, read, "26.12.0");
    const cfg = "--config-file=on.json";
    expect(withEnv([cfg, "--no-watch", "app.ts"])).toMatchObject({
      configFiles: ["on.json"],
      noWatch: true,
    });
    expect(withEnv(["--no_watch", cfg, "app.ts"])).not.toHaveProperty("error");
    expect(withEnv([cfg, "app.ts"], { NODE_OPTIONS: "--no-watch" })).not.toHaveProperty("error");
    expect(withEnv(["--env-file=.env", cfg, "app.ts"])).not.toHaveProperty("error");
    // Only before the entry: after it, the words are the app's.
    expect(withEnv([cfg, "app.ts", "--no-watch"])).toHaveProperty("error");
    // Before each start: an env file that drops --no-watch lets the config file count again.
    const args = { envFiles: [".env"], configFiles: ["on.json"], noWatch: false };
    expect(nestedWatcher(args, {}, read, "26.12.0")).toBeUndefined();
    files[".env"] = "A=1\n";
    expect(nestedWatcher(args, {}, read, "26.12.0")).toMatch(/config file on\.json/);
  });

  test("the last watch flag wins, and the command line beats NODE_OPTIONS", () => {
    const files: Record<string, string> = {};
    const withEnv = (argv: string[], NODE_OPTIONS?: string) =>
      parseWatchArgs(argv, { NODE_OPTIONS }, (f) => files[f]);
    expect(withEnv(["app.ts"], "--watch --no-watch")).not.toHaveProperty("error");
    expect(withEnv(["app.ts"], "--watch-path=src --no_watch")).not.toHaveProperty("error");
    expect(withEnv(["app.ts"], "--no-watch --watch")).toEqual({
      error: expect.stringMatching(/nested/),
    });
    expect(withEnv(["app.ts"], "--no-watch --watch-path=src")).toHaveProperty("error");
    expect(withEnv(["--no-watch", "app.ts"], "--watch")).not.toHaveProperty("error");
    expect(withEnv(["app.ts", "--no-watch"], "--watch")).toHaveProperty("error");
    // NODE_OPTIONS from an env file, read again before each start.
    const args = { envFiles: [".env"], configFiles: [], noWatch: false };
    files[".env"] = "NODE_OPTIONS=--watch --no-watch\n";
    expect(withEnv(["--env-file=.env", "app.ts"])).not.toHaveProperty("error");
    files[".env"] = "NODE_OPTIONS=--no-watch --watch\n";
    expect(nestedWatcher(args, {}, (f) => files[f])).toMatch(/from --env-file/);
    expect(nestedWatcher({ ...args, noWatch: true }, {}, (f) => files[f])).toBeUndefined();
  });

  test("only the config file Node.js reads counts", () => {
    const files: Record<string, string> = {
      "off.json": "{}",
      "on.json": JSON.stringify({ nodeOptions: { watch: true } }),
      "node.config.json": "{}",
    };
    const withFiles = (argv: string[], version: string) =>
      parseWatchArgs(argv, {}, (f) => files[f], version);
    const [off, on] = ["--experimental-config-file=off.json", "--experimental-config-file=on.json"];
    const deflt = "--experimental-default-config-file";
    // From 24.19 and 26.1: the last flag.
    expect(withFiles([off, on, "app.ts"], "24.22.0")).toHaveProperty("error");
    expect(withFiles([on, off, "app.ts"], "26.12.0")).toMatchObject({ configFiles: ["off.json"] });
    expect(withFiles([on, deflt, "app.ts"], "24.22.0")).toMatchObject({
      configFiles: ["node.config.json"],
    });
    // Before: the first file named, and the default one only when none is named.
    expect(withFiles([off, on, "app.ts"], "24.12.0")).toMatchObject({ configFiles: ["off.json"] });
    expect(withFiles([deflt, on, "app.ts"], "22.18.0")).toHaveProperty("error");
    expect(withFiles([deflt, "app.ts"], "22.18.0")).toMatchObject({
      configFiles: ["node.config.json"],
    });
    // `=` with nothing after it names no file.
    expect(withFiles(["--experimental-config-file=", "app.ts"], "26.12.0")).toMatchObject({
      configFiles: [],
    });
  });

  test("a bare config-file flag is read as the Node.js version reads it", () => {
    const files: Record<string, string> = { "node.config.json": "{}", "cfg.json": "{}" };
    const withFiles = (argv: string[], version: string) =>
      parseWatchArgs(argv, {}, (f) => files[f], version);
    const bare = { entry: "app.ts", configFiles: ["node.config.json"] };
    const next = { entry: "app.ts", configFiles: ["cfg.json"] };
    // From 24.19 and 26.1: `node.config.json`, and the next word is the entry.
    expect(withFiles(["--config-file", "app.ts"], "26.12.0")).toMatchObject(bare);
    expect(withFiles(["--experimental-config-file", "app.ts"], "24.19.0")).toMatchObject(bare);
    expect(withFiles(["--experimental-config-file", "app.ts"], "26.1.0")).toMatchObject(bare);
    expect(withFiles(["--experimental-config-file", "app.ts"], "27.0.0")).toMatchObject(bare);
    // Before that, the next word is the path.
    for (const version of ["22.18.0", "24.15.0", "25.9.0", "26.0.0"]) {
      expect(
        withFiles(["--experimental-config-file", "cfg.json", "app.ts"], version),
      ).toMatchObject(next);
    }
  });

  test("nestedWatcher reads the env files again on each call", () => {
    const files: Record<string, string> = { ".env": "A=1\n" };
    const read = (f: string) => files[f];
    const args = { envFiles: [".env"], configFiles: [], noWatch: false };
    expect(nestedWatcher(args, {}, read)).toBeUndefined();
    files[".env"] = "NODE_OPTIONS=--watch-path=src\n";
    expect(nestedWatcher(args, {}, read)).toMatch(/nested watcher \(from --env-file\)/);
    expect(nestedWatcher(args, { NODE_OPTIONS: "" }, read)).toBeUndefined();
  });

  test("the config file and NODE_OPTIONS from an env file, in the order of the Node.js version", () => {
    const files: Record<string, string> = {
      "on.json": JSON.stringify({ nodeOptions: { watch: true } }),
      "off.json": JSON.stringify({ nodeOptions: { watch: false } }),
      "section-off.json": JSON.stringify({ watch: { watch: false } }),
      "none.json": "{}",
      "no.env": "NODE_OPTIONS=--no-watch\n",
      "yes.env": "NODE_OPTIONS=--watch\n",
    };
    const check = (env: string, config: string, version: string) =>
      nestedWatcher(
        { envFiles: [env], configFiles: [config], noWatch: false },
        {},
        (f) => files[f],
        version,
      );
    // From 24.16 and 26.1, the env file wins.
    expect(check("no.env", "on.json", "24.22.0")).toBeUndefined();
    expect(check("yes.env", "off.json", "26.12.0")).toMatch(/from --env-file/);
    expect(check("yes.env", "none.json", "26.12.0")).toMatch(/from --env-file/);
    // Before, the config file wins when it says anything.
    expect(check("no.env", "on.json", "24.15.0")).toMatch(/config file on\.json/);
    expect(check("no.env", "on.json", "25.9.0")).toMatch(/config file on\.json/);
    expect(check("yes.env", "off.json", "24.15.0")).toBeUndefined();
    expect(check("yes.env", "section-off.json", "26.0.0")).toBeUndefined();
    expect(check("yes.env", "none.json", "24.15.0")).toMatch(/from --env-file/);
    // NODE_OPTIONS in the env beats both, on every version.
    const env = (NODE_OPTIONS: string, version: string) =>
      nestedWatcher(
        { envFiles: ["yes.env"], configFiles: ["on.json"], noWatch: false },
        { NODE_OPTIONS },
        (f) => files[f],
        version,
      );
    expect(env("--no-watch", "24.15.0")).toBeUndefined();
    expect(env("--no-watch", "26.12.0")).toBeUndefined();
  });

  test("NODE_OPTIONS is split as Node.js splits it", () => {
    expect(nodeOptionsTokens(' --a  "--watch-path=src dir" "x\\"y" b\\c ')).toEqual([
      "--a",
      "--watch-path=src dir",
      'x"y',
      "b\\c",
    ]);
    expect(err(["app.ts"], { NODE_OPTIONS: '"--watch-path=src dir"' })).toMatch(/nested watcher/);
    expect(err(["app.ts"], { NODE_OPTIONS: '--x "--watch"' })).toMatch(/nested watcher/);
  });

  test("NODE_OPTIONS with --watch from an env file is an error", () => {
    const files: Record<string, string> = {
      ".env": "A=1\nNODE_OPTIONS=--watch\n",
      ".env.ok": "NODE_OPTIONS=--max-old-space-size=100\n",
    };
    const withFiles = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
      parseWatchArgs(argv, env, (f) => files[f]);
    expect(withFiles(["--env-file", ".env", "app.ts"])).toEqual({
      error: expect.stringMatching(/nested watcher \(from --env-file\)/),
    });
    expect(withFiles(["--env-file-if-exists=.env", "app.ts"])).toHaveProperty("error");
    // The last file wins, and NODE_OPTIONS already set wins over the files.
    expect(withFiles(["--env-file=.env.ok", "--env-file=.env", "app.ts"])).toHaveProperty("error");
    expect(withFiles(["--env-file=.env", "--env-file=.env.ok", "app.ts"])).not.toHaveProperty(
      "error",
    );
    expect(withFiles(["--env-file=.env", "app.ts"], { NODE_OPTIONS: "" })).not.toHaveProperty(
      "error",
    );
    expect(withFiles(["--env-file-if-exists=.missing", "app.ts"])).not.toHaveProperty("error");
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
