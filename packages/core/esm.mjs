import { isMainThread, MessageChannel } from "node:worker_threads";

import { createResolve, initTracing, load } from "./index.js";

initTracing();

if (!isMainThread) {
  const mc = new MessageChannel();
  mc.port1.ref();
}

// Duplicated from register.mjs: this module runs on `module.register()`'s
// worker thread and shares nothing with the main thread.
const HELPER_SPECIFIER_PREFIX = "@oxc-node/core/helpers/";

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(HELPER_SPECIFIER_PREFIX)) {
    // Resolve from this file so package self-reference finds the loader's own
    // `@oxc-node/core`, not a copy near the transformed file — which may not
    // exist at all (global install, `node --import`).
    return nextResolve(specifier, { ...context, parentURL: import.meta.url });
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

export { load, resolve };
