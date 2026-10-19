import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Node.js options that take their value as the next token: those `node --help` shows as
 * `--name=...` on Node.js 22, 24 and 26, less test, bench and build-only ones.
 */
export const NODE_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--input-type",
  "--inspect-port",
  "--debug-port",
  "--title",
  "--disable-warning",
  "--redirect-warnings",
  "--report-dir",
  "--report-directory",
  "--diagnostic-dir",
  "--allow-fs-read",
  "--allow-fs-write",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--cpu-prof-name",
  "--disable-proto",
  "--dns-result-order",
  "--experimental-config-file",
  "--experimental-default-type",
  "--experimental-package-map",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--heap-prof-name",
  "--heapsnapshot-near-heap-limit",
  "--heapsnapshot-signal",
  "--icu-data-dir",
  "--inspect-publish-uid",
  "--localstorage-file",
  "--max-http-header-size",
  "--max-old-space-size-percentage",
  "--network-family-autoselection-attempt-timeout",
  "--openssl-config",
  "--report-filename",
  "--report-signal",
  "--secure-heap",
  "--secure-heap-min",
  "--snapshot-blob",
  "--tls-cipher-list",
  "--tls-keylog",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--trace-require-module",
  "--unhandled-rejections",
  "--use-largepages",
  "--v8-pool-size",
  "--vfs-load",
  "--watch-kill-signal",
]);

export interface WatchArgs {
  include: string[];
  exclude: string[];
  clearScreen: boolean;
  killSignal: NodeJS.Signals;
  killTimeout: number;
  rerunOnEnter: boolean | undefined;
  poll: number | false;
  tsconfig?: string;
  help: boolean;
  nodeArgs: string[];
  entry: string;
  envFiles: string[];
  /**
   * The Node.js config file (`--experimental-config-file`, `--config-file`) the child reads, if
   * any: Node.js reads one. Checked for watch mode, and watched.
   */
  configFiles: string[];
  /** `--no-watch` before the entry, which beats NODE_OPTIONS and the config files. */
  noWatch: boolean;
  notes: string[];
}

const DEFAULT_POLL_MS = 300;
// Longer timers fire at once (TimeoutOverflowWarning). Include roots are re-walked every 10 × --poll.
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_POLL_MS = Math.floor(MAX_TIMER_MS / 10);

const NEEDS_ENTRY = `oxnode watch needs an entry file; for tests use \`oxnode --watch --test\``;
const REJECTED: Record<string, string> = {
  "--watch": "use --include",
  "--watch-path": "use --include",
  "-e": NEEDS_ENTRY,
  "--eval": NEEDS_ENTRY,
  "-p": NEEDS_ENTRY,
  "--print": NEEDS_ENTRY,
  "-i": NEEDS_ENTRY,
  "--interactive": NEEDS_ENTRY,
  "--test": NEEDS_ENTRY,
  "--run": NEEDS_ENTRY,
};

function parseBool(name: string, value: string | undefined): boolean | { error: string } {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  return { error: `${name} takes true or false, got "${value}"` };
}

/** NODE_OPTIONS split as Node.js does: at spaces, but not inside `"…"`, where `\` escapes. */
export function nodeOptionsTokens(s: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c === "\\" && quoted) {
      c = s[++i] ?? "";
    } else if (c === " " && !quoted) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
      continue;
    } else if (c === '"') {
      quoted = !quoted;
      continue;
    }
    cur = (cur ?? "") + c;
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

// Node.js takes `_` for `-` in option names: `--watch_path`.
const NO_WATCH = /^--no[-_]watch$/;
/**
 * The last word on watch mode in NODE_OPTIONS: true for --watch or --watch-path (which implies
 * --watch), false for --no-watch. Node.js applies them in order, so the last one wins.
 */
function watchFlag(nodeOptions: string | undefined): boolean | undefined {
  let on: boolean | undefined;
  for (const t of nodeOptionsTokens(nodeOptions ?? "")) {
    if (/^--watch([-_]path)?(=|$)/.test(t)) on = true;
    else if (NO_WATCH.test(t)) on = false;
  }
  return on;
}
const NESTED = "NODE_OPTIONS contains --watch, which would start a nested watcher";

const readEnvFile = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

const NODE_VERSION = process.versions.node;
const majorOf = (version: string) => Number(version.split(".")[0]);

/** Whether `version` has a change released in each `[major, minor]` given, and every later major. */
const atLeast = (version: string, ...mins: [number, number][]) => {
  const [major, minor] = version.split(".").map(Number);
  return mins.some(([m, n]) => major === m && minor >= n) || major > mins[mins.length - 1][0];
};
/** Node.js 24.19 and 26.1 read a bare `--experimental-config-file` as `node.config.json`. */
const bareConfigFlag = (version: string) => atLeast(version, [24, 19], [26, 1]);
/** Before 26.12, Node.js reads a config flag anywhere in argv: after the entry and `--` too. */
const configFlagsAnywhere = (version: string) => !atLeast(version, [26, 12]);
/** Node.js 24.16 and 26.1 apply NODE_OPTIONS from an env file over the config file. */
const dotenvBeatsConfig = (version: string) => atLeast(version, [24, 16], [26, 1]);
/** Node.js 25.4 turns a flag on when the config file has a section named after it. */
const sectionTurnsOn = (version: string) => atLeast(version, [25, 4], [26, 0]);

export function parseWatchArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  read: (file: string) => string | undefined = readEnvFile,
  // The child runs on this Node.js, so its flags are read as this version reads them.
  nodeVersion = NODE_VERSION,
): WatchArgs | { error: string } {
  const polling = env.CHOKIDAR_USEPOLLING === "1" || env.CHOKIDAR_USEPOLLING === "true";
  const out: WatchArgs = {
    include: [],
    exclude: [],
    clearScreen: true,
    killSignal: "SIGTERM",
    killTimeout: 5000,
    rerunOnEnter: undefined,
    poll: polling ? DEFAULT_POLL_MS : false,
    help: false,
    nodeArgs: [],
    entry: "",
    envFiles: [],
    configFiles: [],
    noWatch: false,
    notes: [],
  };

  const configs: ConfigFlag[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      if (i + 1 < argv.length) {
        out.entry = argv[i + 1];
        // Keep `--`, so Node.js also takes an entry starting with `-` as a file.
        out.nodeArgs.push(...argv.slice(i));
      }
      if (configFlagsAnywhere(nodeVersion)) scanConfigs(argv.slice(i + 1), nodeVersion, configs);
      break;
    }
    if (arg === "-") {
      return { error: `- (stdin): ${NEEDS_ENTRY}` };
    }
    if (!arg.startsWith("-")) {
      out.entry = arg;
      out.nodeArgs.push(...argv.slice(i));
      if (configFlagsAnywhere(nodeVersion)) scanConfigs(argv.slice(i + 1), nodeVersion, configs);
      break;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // How Node.js reads the name: `--watch_path` is `--watch-path`.
    const nodeName = name.startsWith("--") ? `--${name.slice(2).replaceAll("_", "-")}` : name;
    // Value flags take `=value` or the next token.
    const value = (): string | undefined => inline ?? argv[++i];

    switch (nodeName) {
      case "-h":
      case "--help":
        out.help = true;
        continue;
      case "--include":
      case "--exclude":
      case "--ignore": {
        const glob = value();
        if (!glob) return { error: `${name} needs a glob` };
        // `!x` excludes x, but `!(x)` is a glob.
        const negated = glob.startsWith("!") && !glob.startsWith("!(");
        if (nodeName === "--include" && !negated) out.include.push(glob);
        else out.exclude.push(nodeName === "--include" ? glob.slice(1) : glob);
        continue;
      }
      case "--clear-screen": {
        const b = parseBool(name, inline);
        if (typeof b !== "boolean") return b;
        out.clearScreen = b;
        continue;
      }
      case "--no-clear-screen":
      case "--watch-preserve-output":
        out.clearScreen = false;
        continue;
      case "--rerun-on-enter": {
        const b = parseBool(name, inline);
        if (typeof b !== "boolean") return b;
        out.rerunOnEnter = b;
        continue;
      }
      case "--no-rerun-on-enter":
        out.rerunOnEnter = false;
        continue;
      case "--kill-signal":
      case "--watch-kill-signal": {
        const sig = value();
        if (!sig || !Object.hasOwn(constants.signals, sig)) {
          return { error: `${name} needs a signal name such as SIGTERM, got "${sig ?? ""}"` };
        }
        out.killSignal = sig as NodeJS.Signals;
        continue;
      }
      case "--kill-timeout": {
        const ms = value();
        if (!ms || !/^\d+$/.test(ms)) {
          return { error: `${name} needs a whole number of milliseconds, got "${ms ?? ""}"` };
        }
        out.killTimeout = Number(ms);
        if (out.killTimeout > MAX_TIMER_MS) {
          return { error: `${name} must be at most ${MAX_TIMER_MS} ms, got "${ms}"` };
        }
        continue;
      }
      case "--poll": {
        if (inline !== undefined && !/^\d+$/.test(inline)) {
          return { error: `--poll takes a whole number of milliseconds, got "${inline}"` };
        }
        out.poll = inline === undefined ? DEFAULT_POLL_MS : Number(inline);
        // 0 would stat every file in a tight loop.
        if (out.poll < 1 || out.poll > MAX_POLL_MS) {
          return { error: `--poll takes 1 to ${MAX_POLL_MS} ms, got "${inline}"` };
        }
        continue;
      }
      case "--tsconfig": {
        const p = value();
        if (!p) return { error: "--tsconfig needs a path" };
        out.tsconfig = p;
        continue;
      }
      case "--no-cache":
        out.notes.push("oxc-node has no transform cache");
        continue;
    }

    if (Object.hasOwn(REJECTED, nodeName)) {
      return { error: `${name} is not supported by oxnode watch: ${REJECTED[nodeName]}` };
    }

    out.nodeArgs.push(arg);
    if (NO_WATCH.test(nodeName)) out.noWatch = true;
    let nodeValue = inline;
    const configFlag =
      nodeName === "--experimental-config-file" ||
      nodeName === "--config-file" ||
      nodeName === "--experimental-default-config-file";
    // Before 24.19 and 26.1, Node.js takes the next word as the config file.
    const takesValue =
      NODE_VALUE_FLAGS.has(nodeName) &&
      !(nodeName === "--experimental-config-file" && bareConfigFlag(nodeVersion));
    if (inline === undefined && takesValue && i + 1 < argv.length) {
      nodeValue = argv[++i];
      out.nodeArgs.push(nodeValue);
    }
    if (
      (nodeName === "--env-file" || nodeName === "--env-file-if-exists") &&
      nodeValue !== undefined
    ) {
      out.envFiles.push(nodeValue);
    }
    if (configFlag) addConfig(configs, nodeName, nodeValue);
  }

  if (!out.entry && !out.help) {
    return { error: "missing <entry>" };
  }
  out.configFiles = pickConfig(configs, nodeVersion);
  const nested = nestedWatcher(out, env, read, nodeVersion);
  return nested ? { error: nested } : out;
}

/** A config flag, and whether it names a file rather than asking for the default one. */
type ConfigFlag = { file: string; named: boolean };

function addConfig(configs: ConfigFlag[], nodeName: string, nodeValue: string | undefined) {
  // `--experimental-config-file=` with nothing after it names no file.
  if (nodeValue === "") return;
  const file = nodeName === "--experimental-default-config-file" ? undefined : nodeValue;
  configs.push({ file: file ?? "node.config.json", named: file !== undefined });
}

/**
 * The one config file Node.js reads. From 24.19 and 26.1 the last config flag wins. Before, the
 * first file named wins, and the default one counts only when none is named.
 */
function pickConfig(configs: ConfigFlag[], nodeVersion: string): string[] {
  const config = bareConfigFlag(nodeVersion)
    ? configs.at(-1)
    : (configs.find((c) => c.named) ?? configs[0]);
  return config ? [config.file] : [];
}

/** Normalized long flag name and inline value: `--watch_path=x` is `--watch-path`, `x`. */
function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  const name = `--${(eq === -1 ? arg : arg.slice(0, eq)).slice(2).replaceAll("_", "-")}`;
  return [name, eq === -1 ? undefined : arg.slice(eq + 1)];
}

const isConfigFlag = (name: string) =>
  name === "--experimental-config-file" ||
  name === "--config-file" ||
  name === "--experimental-default-config-file";

/** Add the config flags in `args`, read as `nodeVersion` reads them. */
function scanConfigs(args: string[], nodeVersion: string, configs: ConfigFlag[]) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const [name, inline] = splitFlag(args[i]);
    if (!isConfigFlag(name)) continue;
    let value = inline;
    const takesValue = name === "--experimental-config-file" && !bareConfigFlag(nodeVersion);
    if (value === undefined && takesValue && i + 1 < args.length) value = args[++i];
    addConfig(configs, name, value);
  }
}

/**
 * The env files and the config file in `argv`, for `oxnode` with no watch command, which does
 * not find the entry: every arg up to `--` is read, so an app arg may count too. Config flags
 * after `--` count where Node.js reads them.
 */
export function nodeFiles(
  argv: string[],
  nodeVersion = NODE_VERSION,
): Pick<WatchArgs, "envFiles" | "configFiles"> {
  const envFiles: string[] = [];
  const end = argv.indexOf("--") === -1 ? argv.length : argv.indexOf("--");
  for (let i = 0; i < end; i++) {
    if (!argv[i].startsWith("--")) continue;
    const [name, inline] = splitFlag(argv[i]);
    if (name !== "--env-file" && name !== "--env-file-if-exists") continue;
    const value = inline ?? (i + 1 < end ? argv[++i] : undefined);
    if (value !== undefined) envFiles.push(value);
  }
  const configs: ConfigFlag[] = [];
  scanConfigs(configFlagsAnywhere(nodeVersion) ? argv : argv.slice(0, end), nodeVersion, configs);
  return { envFiles, configFiles: pickConfig(configs, nodeVersion) };
}

/**
 * Why the child would start a watcher of its own. The command line beats NODE_OPTIONS, which
 * beats the config file. NODE_OPTIONS from an env file beats the config file from 24.16 and 26.1;
 * before, the config file wins. Checked before each start too, as the files may change.
 */
export function nestedWatcher(
  args: Pick<WatchArgs, "envFiles" | "configFiles" | "noWatch">,
  env: NodeJS.ProcessEnv,
  read: (file: string) => string | undefined = readEnvFile,
  nodeVersion = NODE_VERSION,
): string | undefined {
  if (args.noWatch) return undefined;
  const fromEnv = watchFlag(env.NODE_OPTIONS);
  if (fromEnv !== undefined) return fromEnv ? NESTED : undefined;
  const fromFile =
    env.NODE_OPTIONS === undefined
      ? watchFlag(childNodeOptions(env, args.envFiles, read))
      : undefined;
  const config = configFileWatch(args.configFiles, read, nodeVersion);
  const fileWins = dotenvBeatsConfig(nodeVersion) ? fromFile !== undefined : config === undefined;
  if (fileWins) return fromFile ? `${NESTED} (from --env-file)` : undefined;
  return config?.on ? configNested(config.file) : undefined;
}

/**
 * What the Node.js config file says about watch mode: on, off, or nothing (undefined). It applies
 * `nodeOptions` and the `watch` section as flags, and from 25.4 a `watch` section turns on --watch
 * by being there (unless it holds `"watch": false`). With `configs`, Node.js takes the first entry
 * for its major version.
 */
export function configFileWatch(
  configFiles: string[],
  read: (file: string) => string | undefined = readEnvFile,
  nodeVersion = NODE_VERSION,
): { file: string; on: boolean } | undefined {
  const nodeMajor = majorOf(nodeVersion);
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const watchOf = (config: unknown): boolean | undefined => {
    if (!isObject(config)) return undefined;
    const { nodeOptions, watch } = config;
    // Within a set the last key wins, as for flags: `"watch-path": ".", "watch": false` is off.
    const last = (o: Record<string, unknown>) => {
      let on: boolean | undefined;
      for (const [k, v] of Object.entries(o)) {
        if (/^watch([-_]path)?$/.test(k) && v != null) on = v !== false;
      }
      return on;
    };
    const sets = [nodeOptions, watch].filter(isObject).map(last);
    if (sets.includes(true)) return true;
    if (sectionTurnsOn(nodeVersion) && isObject(watch) && watch.watch !== false) return true;
    return sets.includes(false) ? false : undefined;
  };
  for (const file of configFiles) {
    const text = read(file);
    if (text === undefined) continue;
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      continue; // Node.js reports a bad config file itself.
    }
    if (isObject(config) && Array.isArray(config.configs)) {
      const entry = config.configs.find((c) => isObject(c) && c.nodeVersion === nodeMajor);
      config = isObject(entry) ? entry.config : undefined;
    }
    const on = watchOf(config);
    if (on !== undefined) return { file, on };
  }
  return undefined;
}

const configNested = (file: string) =>
  `the Node.js config file ${file} turns on --watch, which would start a nested watcher`;

/** Why the config file alone would start a nested watcher. */
export function configFileNestedWatcher(
  configFiles: string[],
  read: (file: string) => string | undefined = readEnvFile,
  nodeVersion = NODE_VERSION,
): string | undefined {
  const config = configFileWatch(configFiles, read, nodeVersion);
  return config?.on ? configNested(config.file) : undefined;
}

/** NODE_OPTIONS as the child gets it: from --env-file unless it is set already; the last file wins. */
function childNodeOptions(
  env: NodeJS.ProcessEnv,
  envFiles: string[],
  read: (file: string) => string | undefined,
): string | undefined {
  if (env.NODE_OPTIONS !== undefined) return env.NODE_OPTIONS;
  let fromFiles: string | undefined;
  for (const file of envFiles) {
    const text = read(file);
    const value = text === undefined ? undefined : parseEnv(text).NODE_OPTIONS;
    if (value !== undefined) fromFiles = value;
  }
  return fromFiles;
}

/** The child env for `--tsconfig`: oxc-node reads TS_NODE_PROJECT before OXC_TSCONFIG_PATH. */
export function tsconfigEnv(
  tsconfig: string | undefined,
  cwd: string,
): Record<string, string | undefined> {
  return tsconfig ? { OXC_TSCONFIG_PATH: resolve(cwd, tsconfig), TS_NODE_PROJECT: undefined } : {};
}
