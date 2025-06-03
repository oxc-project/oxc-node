_default:
  @just --list -u

alias r := ready

ready:
  just build
  just test

build:
  pnpm --filter @oxc-node/core build
  pnpm --filter @oxc-node/core export-oxc-runtime
  pnpm --filter @oxc-node/cli build
  pnpm install

test:
  pnpm test
