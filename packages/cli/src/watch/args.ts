import { constants } from "node:os";
import { resolve } from "node:path";

/** Node.js options that take their value as the next token. */
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
  if (env.NODE_OPTIONS?.split(/\s+/).some((t) => /^--watch(-path)?(=|$)/.test(t))) {
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
        continue;
      }
      case "--poll": {
        if (inline !== undefined && !/^\d+$/.test(inline)) {
          return { error: `--poll takes a whole number of milliseconds, got "${inline}"` };
        }
        out.poll = inline === undefined ? DEFAULT_POLL_MS : Number(inline);
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

    if (Object.hasOwn(REJECTED, name)) {
      return { error: `${name} is not supported by oxnode watch: ${REJECTED[name]}` };
    }

    out.nodeArgs.push(arg);
    let nodeValue = inline;
    if (inline === undefined && NODE_VALUE_FLAGS.has(name) && i + 1 < argv.length) {
      nodeValue = argv[++i];
      out.nodeArgs.push(nodeValue);
    }
    if ((name === "--env-file" || name === "--env-file-if-exists") && nodeValue !== undefined) {
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
