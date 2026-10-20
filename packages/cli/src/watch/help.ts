/** How the watcher is named in what it prints, for oxnode or a tool that embeds it. */
export interface WatchNames {
  /** The command as typed: `oxnode watch`. */
  name: string;
  /** The tag on log lines: `[oxnode]`. */
  label: string;
  /** Node.js' own watch mode under this tool, or null when it has none to point to. */
  nodeWatch: string | null;
}

export const DEFAULT_NAMES: WatchNames = {
  name: "oxnode watch",
  label: "oxnode",
  nodeWatch: "oxnode --watch",
};

/** The names for `name`. Only oxnode's own name points to `oxnode --watch`. */
export function namesFor(name = DEFAULT_NAMES.name): WatchNames {
  if (name === DEFAULT_NAMES.name) return DEFAULT_NAMES;
  return { name, label: name.split(" ")[0], nodeWatch: null };
}

export const usage = (n: WatchNames = DEFAULT_NAMES) =>
  `Usage: ${n.name} [options] [node options] [--] <entry> [script args...]`;

export const help = (n: WatchNames = DEFAULT_NAMES) => `${usage(n)}

Run <entry> with oxc-node and run it again when a file it uses changes.

Options:
  --include <glob>         Also watch files matching <glob> (repeatable; "!x" excludes)
  --exclude <glob>         Never watch files matching <glob> (repeatable)
  --clear-screen=<bool>    Clear the screen before each rerun (default: true, TTY only)
  --no-clear-screen        Same as --clear-screen=false
  --kill-signal <signal>   Signal that stops the app before a rerun (default: SIGTERM)
  --kill-timeout <ms>      Force kill the app if it is still running after <ms> (default: 5000)
  --rerun-on-enter=<bool>  Rerun when Return is pressed (default: true on a terminal)
  --no-rerun-on-enter      Never read the terminal; the app keeps stdin to itself
  --poll[=<ms>]            Poll files instead of using file system events (Docker, WSL, network drives)
  --tsconfig <path>        Use this tsconfig (same as OXC_TSCONFIG_PATH)
  -h, --help               Show this help

Node.js options go before <entry> (use --flag=value); everything after <entry> goes to the script.
Globs are relative to the current folder. node_modules is not watched unless --include names it.

Watched: every file the app imports or requires (worker threads on Node 24+), the tsconfig files
oxc-node read (with "extends"), files the resolver looked for and did not find, --env-file files,
Node.js config files (--experimental-config-file).

Keys:  Return        rerun now (press again while stopping to force kill)
       Ctrl+C        stop (press again to force kill)

Examples:
  ${n.name} ./src/server.ts
  ${n.name} --include "./config/*.json" --exclude "src/**/*.test.ts" ./src/server.ts --port 3000
  ${n.name} --inspect --clear-screen=false ./src/index.ts
${n.nodeWatch ? `\n\`${n.nodeWatch} <entry>\` still runs Node.js' own watch mode.\n` : ""}`;
