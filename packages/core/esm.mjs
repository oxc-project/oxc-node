import { isMainThread, MessageChannel } from "node:worker_threads";

import { load, resolve } from "./hooks.mjs";

// This module is the entry point used by the asynchronous `module.register()` loader,
// which evaluates it on a dedicated loader thread. Keep that thread alive for the
// lifetime of the loader by holding a referenced port; otherwise it may exit early.
//
// The synchronous `module.registerHooks()` loader does not use this module — it imports
// the hooks directly from `./hooks.mjs` — so this keep-alive (which would otherwise
// pin unrelated worker threads, e.g. test runners, and prevent them from exiting)
// only ever runs on the dedicated loader thread.
if (!isMainThread) {
  const mc = new MessageChannel();
  mc.port1.ref();
}

export { load, resolve };
