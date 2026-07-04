import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  staged: {
    "*": ["vp fmt --no-error-on-unmatched-pattern"],
    "*.@(js|ts|tsx)": ["vp lint --fix"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["**/fixtures/**"],
  },
});
