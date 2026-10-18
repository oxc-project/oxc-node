export const USAGE = `Usage: oxnode watch [options] [node options] [--] <entry> [script args...]`;

export const HELP = `${USAGE}

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
oxc-node read (with "extends"), files the resolver looked for and did not find, --env-file files.

Keys:  Return        rerun now (press again while stopping to force kill)
       Ctrl+C        stop (press again to force kill)

Examples:
  oxnode watch ./src/server.ts
  oxnode watch --include "./config/*.json" --exclude "src/**/*.test.ts" ./src/server.ts --port 3000
  oxnode watch --inspect --clear-screen=false ./src/index.ts

\`oxnode --watch <entry>\` still runs Node.js' own watch mode.
`;
