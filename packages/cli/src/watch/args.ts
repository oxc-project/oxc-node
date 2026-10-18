import { constants } from "node:os";
import { resolve } from "node:path";

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

export function parseWatchArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): WatchArgs | { error: string } {
  // Node.js takes `_` for `-` in option names: `--watch_path`.
  if (env.NODE_OPTIONS?.split(/\s+/).some((t) => /^--watch([-_]path)?(=|$)/.test(t))) {
    return { error: "NODE_OPTIONS contains --watch, which would start a nested watcher" };
  }
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
    notes: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      if (i + 1 < argv.length) {
        out.entry = argv[i + 1];
        // Keep `--`, so Node.js also takes an entry starting with `-` as a file.
        out.nodeArgs.push(...argv.slice(i));
      }
      break;
    }
    if (arg === "-") {
      return { error: `- (stdin): ${NEEDS_ENTRY}` };
    }
    if (!arg.startsWith("-")) {
      out.entry = arg;
      out.nodeArgs.push(...argv.slice(i));
      break;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // How Node.js reads the name: `--watch_path` is `--watch-path`.
    const nodeName = name.startsWith("--") ? `--${name.slice(2).replaceAll("_", "-")}` : name;
    // Value flags take `=value` or the next token.
    const value = (): string | undefined => inline ?? argv[++i];

    switch (name) {
      case "-h":
      case "--help":
        out.help = true;
        continue;
      case "--include":
      case "--exclude":
      case "--ignore": {
        const glob = value();
        if (!glob) return { error: `${name} needs a glob` };
        if (name === "--include" && !glob.startsWith("!")) out.include.push(glob);
        else out.exclude.push(name === "--include" ? glob.slice(1) : glob);
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
    let nodeValue = inline;
    if (inline === undefined && NODE_VALUE_FLAGS.has(nodeName) && i + 1 < argv.length) {
      nodeValue = argv[++i];
      out.nodeArgs.push(nodeValue);
    }
    if (
      (nodeName === "--env-file" || nodeName === "--env-file-if-exists") &&
      nodeValue !== undefined
    ) {
      out.envFiles.push(nodeValue);
    }
  }

  if (!out.entry && !out.help) {
    return { error: "missing <entry>" };
  }
  return out;
}

/** The child env for `--tsconfig`: oxc-node reads TS_NODE_PROJECT before OXC_TSCONFIG_PATH. */
export function tsconfigEnv(
  tsconfig: string | undefined,
  cwd: string,
): Record<string, string | undefined> {
  return tsconfig ? { OXC_TSCONFIG_PATH: resolve(cwd, tsconfig), TS_NODE_PROJECT: undefined } : {};
}
