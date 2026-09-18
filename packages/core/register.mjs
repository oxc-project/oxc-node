import * as NodeModule from "node:module";

import { addHook } from "pirates";

import { OxcTransformer, createResolve, initTracing, load as oxcLoad } from "./index.js";

// Destructure from NodeModule namespace to support older Node.js versions
const { register, registerHooks, setSourceMapsSupport } = NodeModule;

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

/**
 * Whether this request comes from `require()`.
 *
 * `module.register()` never showed `require()` to the hooks; `module.registerHooks()`
 * does. Those requests stay on Node.js' own CommonJS resolution and the `pirates` hook
 * above — exactly where they were before. Node.js resolves them correctly on its own:
 * the `pirates` hook registers the TypeScript extensions in `Module._extensions`, which
 * is what lets its CommonJS resolver complete `require('./foo')` to `./foo.ts`.
 *
 * The discriminator is `importAttributes`, the field that decides whether the native
 * hooks can run at all: `createResolve` and `load` both take it as a required property
 * and reject a context without it. A CommonJS context never carries it, an ESM context
 * always does — even when empty. `conditions` cannot be used for this: `--conditions`
 * appends its values to *every* request, so `--conditions=require` would send imports
 * down the CommonJS path (`ERR_MODULE_NOT_FOUND` for an extensionless specifier) and
 * `--conditions=import` would send `require()` down the ESM one.
 *
 * @param {{ importAttributes?: Record<string, string> } | undefined} context
 * @returns {boolean}
 */
function isCommonJsRequire(context) {
  return context?.importAttributes === undefined;
}

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  if (isCommonJsRequire(context)) {
    return nextResolve(specifier, context);
  }
  return createResolve(
    {
      getCurrentDirectory: () => process.cwd(),
    },
    specifier,
    context,
    nextResolve,
  );
}

/**
 * @type {import('node:module').LoadHook}
 */
function load(url, context, nextLoad) {
  if (isCommonJsRequire(context)) {
    return nextLoad(url, context);
  }
  const result = oxcLoad(url, context, nextLoad);
  // Anything oxc-node itself settles on as CommonJS is left to the CommonJS machinery,
  // which compiles it through the `pirates` hook above and its accurate inline source
  // map. Returning source from here instead costs stack trace precision: a throw in a
  // `.cts` entry gets reported at the transformed position rather than the original one.
  // Asking `oxcLoad` first is what keeps a CommonJS-reported file that actually contains
  // ESM syntax running as an ES module. `commonjs-typescript` — Node.js' own format for a
  // `.ts` file it strips types from — belongs on that same path, hence the prefix test.
  if (result.format.startsWith("commonjs")) {
    // A null source is what `module.register()`'s asynchronous default load returned for
    // every CommonJS module, and it is the one shape that keeps `require()` inside such a
    // module working on every runtime: a source-bearing result made Node.js short-circuit
    // it incorrectly until https://github.com/nodejs/node/pull/62920.
    return { format: result.format, source: null, responseURL: result.responseURL ?? url };
  }
  return result;
}

/**
 * Whether `module.registerHooks()` can be relied on for everything this loader does.
 *
 * `registerHooks` itself landed in v22.15.0 and v23.5.0, but two defects kept it from
 * being a drop-in replacement for far longer, both verified against release binaries:
 *
 * - Until https://github.com/nodejs/node/pull/59011 a synchronous resolve hook had its
 *   `conditions` overridden, which breaks CommonJS named-export detection for a package
 *   imported from ESM: `import { jsx } from 'react/jsx-runtime'` fails with "does not
 *   provide an export named 'jsx'". Fixed in v24.5.0, backported to v22.19.0, and never
 *   backported to the end-of-life 23.x line.
 * - Until https://github.com/nodejs/node/pull/62920 `require()` inside an imported
 *   CommonJS module short-circuited incorrectly whenever a synchronous load hook handed
 *   back source for it, so a `.ts` entry point in a CommonJS package could not
 *   `require()` its own files. Fixed in v26.2.0. The `load` hook above never returns
 *   source for CommonJS, so this defect does not reach it — v26.2.0 is kept as the floor
 *   anyway, because it is the first release where the synchronous hooks are complete
 *   regardless of what a hook returns, and every runtime below it keeps exactly the
 *   behaviour it has today.
 *
 * Below v26.2.0 `module.register()` therefore stays in use, deprecation warning included.
 *
 * @returns {boolean}
 */
function canRegisterSyncHooks() {
  if (typeof registerHooks !== "function") {
    return false;
  }
  const [major, minor] = process.versions.node.split(".", 2).map(Number);
  return major > 26 || (major === 26 && minor >= 2);
}

// `module.register()` is deprecated — DEP0205, runtime-deprecated since v25.9.0 — and
// runs the hooks on a separate thread. Prefer the synchronous, in-thread
// `module.registerHooks()` on every runtime that implements it completely.
if (canRegisterSyncHooks()) {
  initTracing();
  registerHooks({ load, resolve });
} else {
  register("@oxc-node/core/esm", import.meta.url);
}
