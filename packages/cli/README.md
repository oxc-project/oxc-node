# `@oxc-node/cli`

CLI tool for `oxc-node`.

## Features

- Run a script with oxc transformer and oxc-resolver
- Support run TypeScript without any configuration
- Support ESM and CJS
- Support source map

## Installation

Install globally, you can use it replace `node` command anywhere.

```bash
npm install @oxc-node/cli -g
```

## Usage

```bash
oxnode ./path/to/index.ts
```

## Watch mode

Run the app again when a file it uses changes:

```bash
oxnode watch ./src/server.ts
oxnode watch --include "./config/*.json" --exclude "src/**/*.test.ts" ./src/server.ts --port 3000
oxnode watch --inspect --clear-screen=false ./src/index.ts
```

| Command                          | Watcher          |
| -------------------------------- | ---------------- |
| `oxnode watch ./src/server.ts`   | oxnode's own     |
| `oxnode --watch ./src/server.ts` | Node's `--watch` |

Both restart on the files the app loads, on `tsconfig.json` and the files it
`extends`, and on imports that did not resolve yet (not under `oxnode --watch`
on Linux with Node 22 or 24). With `oxnode watch`, press Return to rerun, and
Ctrl+C to stop. Run `oxnode watch --help` for every option.

A script file named exactly `watch` now runs as `oxnode ./watch`.

See the
[Watch mode section](https://github.com/oxc-project/oxc-node#watch-mode) of
the main README for what restarts, the options, the keys and the limits.
