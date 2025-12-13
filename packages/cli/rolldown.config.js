import { defineConfig } from "rolldown";

export default defineConfig({
  input: "./src/index.ts",
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
