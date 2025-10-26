_default:
  @just --list -u

alias r := ready

ready:
  just build
  just test

build: build-core build-cli
  pnpm install

build-cli: build-core
  pnpm --filter @oxc-node/cli build

build-core:
  pnpm --filter @oxc-node/core build
  pnpm --filter @oxc-node/core export-oxc-runtime

test: test-cli


test-cli: build-cli
  pnpm --filter @oxc-node/cli-tests test
