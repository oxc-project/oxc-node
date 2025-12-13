import * as NodeModule from "node:module";

import { addHook } from "pirates";

import { OxcTransformer } from "./index.js";

// Destructure from NodeModule namespace to support older Node.js versions
const { register, setSourceMapsSupport } = NodeModule;

const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
  ".es6",
  ".es",
]);

register("@oxc-node/core/esm", import.meta.url);

if (typeof setSourceMapsSupport === "function") {
  setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
} else if (typeof process.setSourceMapsEnabled === "function") {
  process.setSourceMapsEnabled(true);
}

const transformer = new OxcTransformer(process.cwd());
const SOURCEMAP_PREFIX = "\n//# sourceMappingURL=";
const SOURCEMAP_MIME = "data:application/json;charset=utf-8;base64,";

addHook(
  (code, filename) => {
    const output = transformer.transform(filename, code);
    let transformed = output.source();
    const sourceMap = output.sourceMap();

    if (sourceMap) {
      const inlineMap = Buffer.from(sourceMap, "utf8").toString("base64");
      transformed += SOURCEMAP_PREFIX + SOURCEMAP_MIME + inlineMap;
    }

    return transformed;
  },
  {
    ext: Array.from(DEFAULT_EXTENSIONS),
  },
);
