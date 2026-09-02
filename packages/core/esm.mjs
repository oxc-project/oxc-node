import { isMainThread, MessageChannel } from "node:worker_threads";

import { createResolve, initTracing, load } from "./index.js";

initTracing();

if (!isMainThread) {
  const mc = new MessageChannel();
  mc.port1.ref();
}

/**
 * @type {import('node:module').ResolveHook}
 */
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
