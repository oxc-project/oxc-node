import * as NodeModule from "node:module";

import { addHook } from "pirates";

import { DEFAULT_EXTENSIONS, load, resolve, supportsRegisterHooks } from "./hooks.mjs";
import { initTracing, OxcTransformer } from "./index.js";

// Destructure from NodeModule namespace to support older Node.js versions
const { register, registerHooks, setSourceMapsSupport } = NodeModule;

// Prefer the synchronous, in-thread `module.registerHooks()`: `module.register()` has been
// runtime deprecated as DEP0205 since Node.js v26.0.0 and emits a warning on every
// invocation. `supportsRegisterHooks` is a version check rather than a feature check —
// see its doc comment for the Node.js bug that makes older versions unusable.
if (typeof registerHooks === "function" && supportsRegisterHooks(process.versions.node)) {
  initTracing();
  registerHooks({ load, resolve });
} else {
  register("@oxc-node/core/esm", import.meta.url);
}

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
    ext: DEFAULT_EXTENSIONS,
  },
);
