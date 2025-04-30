build:
  pnpm --filter @oxc-node/core build
  pnpm --filter @oxc-node/core export-oxc-runtime
  pnpm --filter @oxc-node/cli build

test:
  pnpm test
