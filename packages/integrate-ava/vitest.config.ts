import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.spec.ts"],
    // Match the previous ava timeout (1m); the subprocess specs spawn node.
    testTimeout: 60_000,
    server: {
      deps: {
        // @oxc-node/core is a native (napi) CommonJS addon. Keep it external so
        // Node loads the `.node` binding directly instead of Vite transforming it.
        external: ["@oxc-node/core"],
      },
    },
  },
});
