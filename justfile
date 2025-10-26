_default:
  @just --list -u

alias r := ready

ready:
  just build
  just test

build: build-core
  pnpm --filter @oxc-node/cli build
  pnpm install

build-core:
  pnpm --filter @oxc-node/core build
  pnpm --filter @oxc-node/core export-oxc-runtime

test:
  pnpm test
