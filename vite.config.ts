import { defineConfig } from "vite-plus";

const ignorePatterns = [
  "**/fixtures/**",
  "/packages/core/browser.js",
  "/packages/core/index.js",
  "/packages/core/index.d.ts",
  "/packages/core/oxc-node.wasi.cjs",
  "/packages/core/oxc-node.wasi-browser.js",
  "/packages/core/wasi-worker-browser.mjs",
  "/packages/core/wasi-worker.mjs",
];

export default defineConfig({
  fmt: {
    ignorePatterns,
  },
  staged: {
    "*": ["vp fmt --no-error-on-unmatched-pattern"],
    "*.@(js|ts|tsx)": ["vp lint --fix"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns,
  },
});
