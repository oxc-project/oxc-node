import { isMainThread, MessageChannel } from "node:worker_threads";

import { createResolve, initTracing, load } from "./index.js";

initTracing();

// This module is the entry point used by the asynchronous `module.register()` loader
// (the fallback for Node.js versions without `module.registerHooks()`), which evaluates
// it on a dedicated loader thread. Keep that thread alive for the lifetime of the loader
// by holding a referenced port; otherwise it may exit early.
if (!isMainThread) {
  const mc = new MessageChannel();
  mc.port1.ref();
}

// The asynchronous worker-thread loader does not exhibit the synchronous-loader CommonJS
// interop issues that `hooks.mjs` works around (named-export detection, `require()` of
// TypeScript, source maps), and its `nextResolve` is async — so the synchronous-only
// fast paths in `hooks.mjs` do not apply here. Use the plain resolver directly.
function resolve(specifier, context, nextResolve) {
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
