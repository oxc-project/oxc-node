# `oxc-node`

[![Build Status][ci-badge]][ci-url]
[![npmjs.com][npm-badge]][npm-url]

Run TypeScript directly in Node.js, powered by
[Oxc](https://github.com/oxc-project/oxc).

`oxc-node` adds module resolution and transformation hooks to Node. When Node
loads a file, `oxc-node` resolves the import with
[oxc-resolver](https://github.com/oxc-project/oxc-resolver), transforms the
source with Oxc, and returns JavaScript with an inline source map for Node to
execute.

Node remains the runtime. `oxc-node` is not a JavaScript runtime, bundler, or
type checker, and it does not write build output to disk.

## What it supports

- TypeScript and TSX without a separate build step
- ESM and CommonJS, including `.mts`, `.cts`, `.mjs`, and `.cjs`
- JSX and selected TypeScript compiler options
- `tsconfig.json` path aliases and TypeScript-aware import resolution
- Imports such as `./file.js` resolving to `./file.ts` or `./file.tsx`
- Source-mapped stack traces
- Importing TypeScript from a tool, without hooks (`@oxc-node/core/importer`)
- Node features and flags such as watch mode, the test runner, and the
  inspector

Type annotations are removed at runtime, not checked. Run a type checker
separately when you need type safety.

## CLI

Install the CLI in a project:

```bash
npm install --save-dev @oxc-node/cli
```

Run a TypeScript entry point:

```bash
npx oxnode ./src/index.ts
```

`oxnode` starts Node with the `@oxc-node/core` hooks and source maps enabled.
Arguments are passed through to Node, so normal Node workflows continue to
work:

```bash
npx oxnode --watch ./src/server.ts
npx oxnode --test
npx oxnode --inspect ./src/index.ts
```

Running `oxnode` without arguments starts the Node REPL. Use
`oxnode --node-help` to print Node's help; `oxnode --help` prints help for the
wrapper.

## Watch mode

There are two watch modes:

| Command                          | Watcher          | Use it for                                                   |
| -------------------------------- | ---------------- | ------------------------------------------------------------ |
| `oxnode watch ./src/server.ts`   | oxnode's own     | globs, Return to rerun, a kill timeout, polling              |
| `oxnode --watch ./src/server.ts` | Node's `--watch` | Node's own flags, such as `--watch-path` or `--watch --test` |

```bash
npx oxnode watch ./src/server.ts
npx oxnode watch --include "./config/*.json" --exclude "src/**/*.test.ts" ./src/server.ts --port 3000
npx oxnode watch --inspect --clear-screen=false ./src/index.ts
```

```
oxnode watch [watch options] [node options] [--] <entry> [script args...]
             └─────── before the entry ────────┘         └─ to the app ─┘
```

Write Node options as `--flag=value`. Everything after the entry goes to the
script, so `--port 3000` above reaches the app.

The output looks like this:

```
16:14:24 [oxnode] watching for changes (Enter to rerun)
RUN v1
16:14:27 [oxnode] change in ./src/dep.ts, restarting
RUN v2
16:14:31 [oxnode] exited with code 1 — waiting for changes (Enter to rerun)
```

When the app exits or crashes, `oxnode watch` keeps watching and runs it again
on the next change.

### What restarts

| A change to                                          | `oxnode watch`             | `oxnode --watch`                  |
| ---------------------------------------------------- | -------------------------- | --------------------------------- |
| a file the app imports or requires                   | yes                        | yes                               |
| `tsconfig.json` and every file it `extends`          | yes                        | yes                               |
| a file that did not exist yet (`x.ts` for `./x.js`)  | yes                        | yes, except Linux with Node 22/24 |
| a module loaded in a worker thread                   | Node 24+                   | Node 24+                          |
| an `--env-file` file                                 | yes                        | yes                               |
| a Node.js config file (`--experimental-config-file`) | yes                        | no                                |
| the `--tsconfig` file                                | yes                        | (no such flag)                    |
| a file matching `--include`                          | yes, even if created later | use `--watch-path`                |
| a file in `node_modules`                             | only with `--include`      | Node's rules                      |
| a file matching `--exclude`                          | no                         | (no such flag)                    |

Globs are relative to the current folder. An imported file counts only while
the app imports it: before each rerun, oxnode forgets what the last run
imported, as Node does.

### Options

These are the options from `oxnode watch --help`:

| Option                    | What it does                                                                 |
| ------------------------- | ---------------------------------------------------------------------------- |
| `--include <glob>`        | Also watch files matching `<glob>` (repeatable; `"!x"` excludes)             |
| `--exclude <glob>`        | Never watch files matching `<glob>` (repeatable)                             |
| `--clear-screen=<bool>`   | Clear the screen before each rerun (default: true, TTY only)                 |
| `--no-clear-screen`       | Same as `--clear-screen=false`                                               |
| `--kill-signal <signal>`  | Signal that stops the app before a rerun (default: SIGTERM)                  |
| `--kill-timeout <ms>`     | Force kill the app if it is still running after `<ms>` (default: 5000)       |
| `--rerun-on-enter=<bool>` | Rerun when Return is pressed (default: true on a terminal)                   |
| `--no-rerun-on-enter`     | Never read the terminal; the app keeps stdin to itself                       |
| `--poll[=<ms>]`           | Poll files instead of using file system events (Docker, WSL, network drives) |
| `--tsconfig <path>`       | Use this tsconfig (same as OXC_TSCONFIG_PATH)                                |
| `-h`, `--help`            | Show this help                                                               |

`--poll` checks every 300 ms by default. `--kill-timeout=0` force kills at
once. Setting `CHOKIDAR_USEPOLLING=1` also turns on `--poll`.

For scripts moved from `tsx`, these also work:

| tsx flag                  | Same as                         |
| ------------------------- | ------------------------------- |
| `--ignore <glob>`         | `--exclude <glob>`              |
| `--watch-preserve-output` | `--no-clear-screen`             |
| `--watch-kill-signal <s>` | `--kill-signal <s>`             |
| `--no-cache`              | nothing (oxc-node has no cache) |

`oxnode watch` needs an entry file. It refuses `--watch`, `--watch-path`
(use `--include`), and `-e`, `-p`, `-i`, `--test`, `--run` and `-`. For tests,
use `oxnode --watch --test`.

### Keys

| Key    | While the app runs | While oxnode is stopping the app |
| ------ | ------------------ | -------------------------------- |
| Return | rerun now          | force kill now                   |
| Ctrl+C | stop               | press again to force kill        |

A rerun first sends `--kill-signal` to the app. If the app is still running
after `--kill-timeout`, oxnode kills it and every process it started. A
second Ctrl+C counts only when it comes more than half a second after the
first one.

### Exit codes and signals

| Case                                     | `oxnode`, `oxnode --watch`                     | `oxnode watch`                            |
| ---------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| the app exits with a code                | the same code                                  | keeps watching                            |
| the app is killed by a signal            | ends by the same signal (the shell sees 128+n) | keeps watching                            |
| the app dies by a core-dump signal       | exits with 128+n, without its own core dump    | keeps watching                            |
| you stop oxnode (Ctrl+C, `SIGTERM`)      | the app's result, as above                     | the app's exit code if it had one, else 0 |
| you stop it while the app is not running |                                                | 0                                         |
| the app cannot start                     | 1                                              | 1                                         |
| bad watch option, or no entry            |                                                | 1                                         |

`SIGINT`, `SIGTERM` and `SIGHUP` sent to `oxnode` reach the app once. Ctrl+C
is not sent twice, and the second `SIGINT` that `npm run` sends is dropped.
Under `oxnode --watch`, `SIGHUP` is passed on as `SIGTERM`, because Node's
watcher ignores `SIGHUP`.

### Limits

- **Node 22 and worker threads.** Modules loaded only in a worker thread are
  not tracked. Add them with `--include`.
- **`oxnode --watch` on Linux with Node 22 or 24.** Node's watcher cannot watch
  a file that does not exist yet, so creating a missing import does not
  restart. Use `oxnode watch`, or Node 26.
- **Docker, WSL (`/mnt/c`) and network drives** often send no file events. Use
  `--poll`.
- **Linux `ENOSPC`.** Raise `fs.inotify.max_user_watches`, or use `--poll`.
- **Globs** need Node 22.5 or later.
- **Return and stdin.** On a terminal, oxnode and the app both read stdin, so a
  line typed for the app can go to oxnode. If the app reads the terminal (a
  prompt or a TUI), use `--no-rerun-on-enter`. Piped stdin always goes to the
  app, unless you pass `--rerun-on-enter`.
- **Background jobs.** `oxnode watch app.ts &` does not read the terminal. A job
  moved to the background later (Ctrl+Z, then `bg`) stops on its next read; use
  `--no-rerun-on-enter` for that.
- **Windows** has no graceful stop before a rerun: oxnode ends the app and its
  children at once, and `--kill-signal` is ignored.
- **A script named `watch`.** `oxnode watch` is now the watch command, so run a
  file named exactly `watch` as `oxnode ./watch`.

### Embedding the watcher

A tool with its own loader built on the oxc-node binding (Vite+'s `vpx watch`,
for example) can run the same watcher. Both sides have an entry:

```
 your CLI                                        the app (your loader)
 runWatch(argv, options)  ── node <loaderArgs> <node options> <entry> ──▶  installSignalAck()
   @oxc-node/cli/watch                                                     watchSink(), withFlush()
                          ◀── IPC { "watch:import": [url] } ──────────────   @oxc-node/core/watch-report
                          ◀── "I" on the OXNODE_SIGNAL_ACK socket ─────────   @oxc-node/core/signal-ack
```

The watcher side:

```js
import { runWatch } from "@oxc-node/cli/watch";

process.exitCode = await runWatch(process.argv.slice(2), {
  name: "vpx watch",
  loaderArgs: ["--enable-source-maps", "--require", preloadPath, "--import", hooksURL],
  ignoreDirs: [loaderDir],
});
```

| Option       | Default                                                                          | What it does                                                                                    |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `loaderArgs` | `["--enable-source-maps", "--import", "@oxc-node/core/register"]`                | Node.js flags that load your hooks, put before the user's Node.js options                       |
| `ignoreDirs` | the folder of `@oxc-node/core/register`, if `loaderArgs` is not given, else none | Folders of your loader's own files: Node.js reports them, but they are not watched              |
| `name`       | `"oxnode watch"`                                                                 | The command in errors, the usage line and `--help`; its first word tags the log lines (`[vpx]`) |

`runWatch` resolves with the exit code once the watcher stops. Until then it
handles `SIGINT`, `SIGTERM`, `SIGHUP`, stdin (Return) and the IPC channel of
the process, so add no handlers of your own and run one at a time. Importing
`@oxc-node/cli/watch` starts nothing, and it does not load clipanion or the
binding.

The app side, in your loader. `take` is your binding's
`takeWatchDependencies`, so these entries load no binding of their own:

```js
import { isMainThread } from "node:worker_threads";
import { installSignalAck } from "@oxc-node/core/signal-ack";
import { watchSink, withFlush } from "@oxc-node/core/watch-report";
import { enableWatchReport, takeWatchDependencies } from "<your binding>";

if (isMainThread) installSignalAck(); // first, before the app's code
const sink = watchSink(); // once per thread; share it between your --require and --import
if (sink) enableWatchReport(); // before the first resolve or transform
const hooks = sink
  ? {
      resolve: withFlush(resolve, sink, takeWatchDependencies),
      load: withFlush(load, sink, takeWatchDependencies),
    }
  : { resolve, load };
```

`flush(sink, take)` sends what the binding recorded, for code that is not a
hook (a CommonJS transform). `createRelay(sink, take)` returns a port for hooks
registered with `module.register()`, which run on a thread with no IPC.
From a CommonJS `--require` preload, `require()` of these two entries works on
Node.js 22.12 and later, as for `@oxc-node/core/importer`.

What the two sides agree on, for a loader that does not use these entries:

- **Start.** The app runs as `node <loaderArgs> <node options> <entry> <script args>`
  with stdio `["inherit", "inherit", "inherit", "ipc"]`, and
  `WATCH_REPORT_DEPENDENCIES=1` in its environment.
- **Reports.** The app sends `{ "watch:import": [url] }` (or `"watch:require"`)
  over IPC. Each entry is a `file:` URL or an absolute path; a bad one is
  skipped alone. A report the loader makes itself (a tsconfig it read, a path a
  failed resolve looked for) also has `"oxc-node": true`: it counts even under
  `node_modules`, and is dropped before each rerun. Other messages pass through
  both ways.
- **Ctrl+C.** On POSIX, `OXNODE_SIGNAL_ACK` names a unix socket. While the app
  has a `SIGINT` listener of its own, it writes the byte `I` to the socket for
  each `SIGINT` it gets, and the watcher then does not send it a second one.
  The app removes the variable before its code runs. With no socket, or no
  `I`, the watcher passes `SIGINT` on as before.

`OXNODE_WATCH_DEBUG`, its output, and the log text are not part of this.

## Node hook

If you do not need the wrapper CLI, install the core package:

```bash
npm install --save-dev @oxc-node/core
```

Register it with any Node command:

```bash
node --import @oxc-node/core/register ./path/to/entry.ts
node --import @oxc-node/core/register --test
```

The register entry point installs both the ESM loader hooks and a CommonJS
transform hook.

## Configuration

By default, each file is governed by the nearest `tsconfig.json` in its own
ancestor directories that claims it through `files`, `include`, `exclude` or a
project reference — the same rule `tsc` follows. A file in a sub-project without
its own `tsconfig.json` therefore inherits the workspace root one, and a file
that no config claims is compiled with no options at all.

`include` only covers `.js`, `.jsx`, `.mjs` and `.cjs` files when `allowJs` is
enabled, so by default no config claims them and they are compiled with no
options. For **module resolution** they are matched as if they were TypeScript,
which keeps path aliases working from JavaScript without `allowJs`.

A `tsconfig.json` that fails to parse stops the search: that file and every
directory above it are skipped, and the file is compiled with no options.
Comments and trailing commas are fine — only genuinely invalid JSON does this.
Run with `OXC_LOG=debug` to see which config was picked for each file.

Set `OXC_TSCONFIG_PATH` to pin one config for every file instead. `TS_NODE_PROJECT`
is also supported and takes precedence when both variables are set; an empty value
counts as unset. Naming a file that does not exist disables `tsconfig.json`
handling entirely rather than falling back to the search above.

A tool that wraps the loader can name the config through the API instead, so the
choice does not leak into `process.env` and from there into the user's script and
the processes it spawns:

```js
import { setTsconfigPath } from "@oxc-node/core";

setTsconfigPath("./tsconfig.app.json");
await import("@oxc-node/core/register");
```

A path set this way takes precedence over both environment variables, and a
relative path resolves against the working directory, just as theirs does. The
config is read once per process, so call `setTsconfigPath` before the first
transform or resolve; calling it later with a different path throws.

The supported `tsconfig.json` options are used for resolution and
transformation. These include path aliases, module and JSX settings, legacy
decorators and decorator metadata, class-field semantics, and relative import
extension rewriting.

The loader does not transform files in `node_modules` by default. Set
`OXC_TRANSFORM_ALL=typescript` to transform only the TypeScript dependencies —
`.ts`, `.mts`, `.cts` and `.tsx`; JavaScript dependencies are still left to
Node.js — or `OXC_TRANSFORM_ALL=1` if every dependency needs transformation.
Absent, empty, `0` and `false` all keep dependencies untouched.

A tool that wraps the loader can choose through the API instead, so the choice
does not leak into `process.env` and from there into the user's script and the
processes it spawns:

```js
import { setTransformDeps } from "@oxc-node/core";

setTransformDeps("typescript");
await import("@oxc-node/core/register");
```

The setter accepts `"typescript"`, `"all"` and `"off"` — the last keeps
dependencies untouched even when the variable asks for more. A mode set this
way takes precedence over `OXC_TRANSFORM_ALL`, and `null`
clears the override. The mode is read once per process, so call
`setTransformDeps` before the first transform or resolve; on the
`module.register()` path the deadline is the `register` import itself, which
fixes the mode for the hook thread. Calling it later with a different mode
throws. On WASI the hook thread instantiates its own copy of the binding, so
the mode in effect when `@oxc-node/core/register` is imported is the one the
ESM hooks see.

`OXC_TRANSFORM_ALL=typescript` predates no older release: a version before
this one reads any non-empty, non-`0`/`false` value as transform-all, so if an
older copy is registered alongside (`NODE_OPTIONS` preloading a global install
is the common case) it transforms JavaScript dependencies too. The
`setTransformDeps` API is invisible to older copies and avoids that entirely.

## Programmatic transformation

`@oxc-node/core` also exposes the native Oxc transformer:

```js
import { OxcTransformer } from "@oxc-node/core";

const transformer = new OxcTransformer(process.cwd());
const output = await transformer.transformAsync("example.ts", "const answer: number = 42;");

console.log(output.source());
console.log(output.sourceMap());
```

The standalone transformer emits CommonJS. The registered loader preserves the
module format selected for ESM files.

A `.cts` file is CommonJS, so it cannot use ES module syntax (`import`, `export`,
or `import.meta`): oxc does not compile it to CommonJS the way `tsc` and `tsx` do,
and the loader reports an error instead. Rename such a file to `.mts`, or write it
with `import x = require()` and `export =`. Type-only imports and exports are fine.

## Importing TypeScript from a tool

A tool that loads a user's config file, such as `eslint.config.ts`, can import
TypeScript without registering the hooks for the whole process.
`@oxc-node/core/importer` has the shape of [jiti](https://github.com/unjs/jiti)
v2:

```js
import { createImporter } from "@oxc-node/core/importer";

const importer = createImporter(import.meta.url);
const config = await importer.import("./eslint.config.ts", { default: true });
```

From CommonJS, `require("@oxc-node/core/importer")` works on Node.js 22.12 and
later.

- `createImporter(parentId, options)` makes an importer that resolves from
  `parentId`, a file path or a `file:` URL. A path that ends in `/` is a
  directory, and its own `tsconfig.json` applies. The options are `moduleCache` and
  `interopDefault`, both `true` by default.
- `importer.import(id, options)` imports a module and returns a promise. With
  `default: true` it returns the default export, or the whole module when the
  default export is missing, `null` or `undefined` (`mod.default ?? mod`, as in jiti). `parentURL` resolves from another file, `conditions` replaces the export
  conditions (`["node", "import"]`), and `try: true` returns `undefined` when the
  module is not found or its package does not export it.
- `importer.resolve(id, options)` returns a `file:` URL, or a `node:` id for a
  built-in module. It takes `parentURL`, `conditions` and `try` too.

The importer runs modules itself instead of through Node's loader, so nothing is
installed in the process: no loader hooks, no `require.extensions`, nothing in
`require.cache`, and `process.sourceMapsEnabled` stays as it is. Your own
`import()` and `require()` calls keep working as before. Inside the importer:

- Files are transformed as the loader transforms them, with the same
  `tsconfig.json` lookup: path aliases, enums, legacy decorators, JSX,
  extensionless imports, JSON, `.mts`/`.cts`, top-level await.
- A file is an ES module when its extension or `package.json` says so, or when it
  uses `import`, `export`, `import.meta` or top-level await. Other files run as
  CommonJS, even when `tsconfig.json` sets an ES `module`.
- A CommonJS file can `require()` an ES module file, as on newer Node.js. A
  module with top-level await throws `ERR_REQUIRE_ASYNC_MODULE` instead.
- Built-in modules, `@oxc-node/core` helpers and JavaScript files in
  `node_modules` are loaded by Node itself. TypeScript files in `node_modules`
  run in the importer.
- With `moduleCache: true`, every importer in the process shares one module map,
  so each file runs once. With `false`, every `import()` call runs your files
  again, which picks up edits; files Node loads stay in Node's own cache.
- `interopDefault` copies jiti: the properties of the default export can be read
  from the module too.
- As in jiti, `__dirname`, `__filename` and `require` work in ES module files too,
  and an import of CommonJS that Babel or `tsc` compiled from an ES module
  (`__esModule`) gets its `exports.default` as the default export.
- A module that failed to load is tried again on the next `import()`. A missing
  module fails with `ERR_MODULE_NOT_FOUND`, or `MODULE_NOT_FOUND` from
  `require()`, and a path a package does not export with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Each line of the output keeps the line number of its source where it can, so
  stack traces point at the right TypeScript line. An error that escapes `import()` also has
  its columns mapped back through the source map.

Differences from jiti:

- There is only the async `import()`. jiti's synchronous `jiti()` call and options
  such as `alias`, `fsCache` and `transformOptions` are not there; the transform
  is configured through `tsconfig.json`, as for the loader.
- The returned module is a plain object, not a real module namespace object.
- `import()` inside `eval` or `new Function` falls back to Node's own loader,
  which does not transform TypeScript. Node may print an experimental warning the
  first time.

A tool that reloads a config after it changes, such as a migration tool or a
linter in watch mode:

```js
import { pathToFileURL } from "node:url";
import { createImporter } from "@oxc-node/core/importer";

export async function loadConfig(file) {
  const url = pathToFileURL(file);
  const importer = createImporter(url, { moduleCache: false });
  return importer.import(url, { default: true });
}
```

[ci-badge]: https://github.com/oxc-project/oxc-node/actions/workflows/CI.yml/badge.svg?branch=main
[ci-url]: https://github.com/oxc-project/oxc-node/actions/workflows/CI.yml
[npm-url]: https://npmx.dev/package/@oxc-node/core
[npm-badge]: https://img.shields.io/npm/dw/@oxc-node/core?label=npm

# [Sponsored By](https://oxc.rs/sponsor)

<p align="center">
  <a href="https://oxc.rs/sponsor">
    <img src="https://raw.githubusercontent.com/oxc-project/sponsors/main/sponsors.svg" alt="Our sponsors" />
  </a>
</p>
