# `oxc-node`

[![Build Status][ci-badge]][ci-url]
[![npmjs.com][npm-badge]][npm-url]

Fast and friendly Node.js dev tool based on [Oxc](https://github.com/oxc-project/oxc).

## `@oxc-node/core`

Transformer and register for Node.js projects.

### Usage

```bash
node --import @oxc-node/core/register ./path/to/entry.ts
```

### `tsconfig.json` discovery

On startup, oxc-node resolves a `tsconfig.json` using this precedence:

1. `TS_NODE_PROJECT` — used as-is if set.
2. `OXC_TSCONFIG_PATH` — used as-is if set.
3. `tsconfig.json` in the current working directory.
4. If none of the above exist, walk up parent directories and use the first
   `tsconfig.json` found. This makes a root-workspace `tsconfig.json` (e.g. one
   with `experimentalDecorators: true`) apply to sub-projects that don't have
   their own config.

To opt out of the walk-up, point `TS_NODE_PROJECT` or `OXC_TSCONFIG_PATH` at an
explicit path (a non-existent path disables discovery entirely).

## [Sponsored By](https://github.com/sponsors/Boshen)

<p align="center">
  <a href="https://github.com/sponsors/Boshen">
    <img src="https://raw.githubusercontent.com/Boshen/sponsors/main/sponsors.svg" alt="My sponsors" />
  </a>
</p>

[ci-badge]: https://github.com/oxc-project/oxc-node/actions/workflows/CI.yml/badge.svg?branch=main
[ci-url]: https://github.com/oxc-project/oxc-node/actions/workflows/CI.yml
[npm-url]: https://npmx.dev/package/@oxc-node/core
[npm-badge]: https://img.shields.io/npm/dw/@oxc-node/core?label=npm
