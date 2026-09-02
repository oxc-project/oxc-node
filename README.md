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

Set `OXC_TSCONFIG_PATH` to pin one config for every file instead. `TS_NODE_PROJECT`
is also supported and takes precedence when both variables are set; an empty value
counts as unset. Naming a file that does not exist disables `tsconfig.json`
handling entirely rather than falling back to the search above.

The supported `tsconfig.json` options are used for resolution and
transformation. These include path aliases, module and JSX settings, legacy
decorators and decorator metadata, class-field semantics, and relative import
extension rewriting.

The ESM loader does not transform files in `node_modules` by default. Set
`OXC_TRANSFORM_ALL=1` if ESM dependencies also need transformation.

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
