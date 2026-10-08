import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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
const requireHelper = createRequire(import.meta.url);

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(HELPER_SPECIFIER_PREFIX)) {
    // Resolve from this file's own copy — `createRequire` uses Node.js' resolver
    // without consulting the hook chain, so an earlier-registered copy's resolve hook
    // cannot re-claim the specifier. The resolved URL is still passed down the chain
    // so format detection and any other hooks run on it. The specifier is not
    // forwarded: that is exactly what let an inner hook rewrite `parentURL` to its
    // own module.
    return nextResolve(pathToFileURL(requireHelper.resolve(specifier)).href, context);
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
