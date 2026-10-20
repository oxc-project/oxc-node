import { defineConfig } from "rolldown";

export default defineConfig({
  // `watch` is the watcher alone (`@oxc-node/cli/watch`); it must not reach index.js.
  input: { index: "./src/index.ts", watch: "./src/watch/index.ts" },
  resolve: {
    conditionNames: ["module", "node"],
    mainFields: ["module", "main"],
  },
  platform: "node",
  external: ["@oxc-node/core"],
  treeshake: true,
  output: {
    format: "esm",
    assetFileNames: "[name].js",
  },
});
