// Watch mode (`node --watch`, `oxnode watch`) restarts on the files the child
// reports over IPC as `{ "watch:import": [url] }`. Node.js reports the modules
// it loads; this reports what only oxc-node knows: the tsconfig files it read
// and the paths a failed resolve looked for (issue #450). A loader that expands
// globs sends `{ "watch:glob": [...] }` through the same sink, for files that
// appear later.
//
// Public as `@oxc-node/core/watch-report`, for a loader of its own built on the
// binding (issue #871). It loads no binding: `take` is the caller's
// `takeWatchDependencies`, and `takeGlobs` its `takeWatchGlobs`. The protocol is
// in the README, "Embedding the watcher".
import { isMainThread, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

const WATCH_CHANNEL = "@oxc-node/core:watch-deps";

/**
 * Where this thread sends its reports, or `null` when nobody is watching. With
 * `null` nothing is wrapped, opened or listened to.
 *
 * @returns {((message: { "watch:import": string[] } | { "watch:glob": object[] }) => void) | null}
 */
export function watchSink() {
  if (!process.env.WATCH_REPORT_DEPENDENCIES) {
    return null;
  }
  if (isMainThread) {
    // `--watch-path` sets the variable without an IPC channel.
    if (typeof process.send !== "function") {
      return null;
    }
    const seen = new Set();
    const send = (message) => {
      if (!process.connected) {
        return;
      }
      // A glob report goes as it is: the files it lists are those of this run.
      if (!Array.isArray(message?.["watch:glob"])) {
        const url = message?.["watch:import"]?.[0];
        if (typeof url !== "string" || seen.has(url)) {
          return;
        }
        seen.add(url);
      }
      try {
        // The callback keeps a failed send from becoming an 'error' event.
        process.send(message, () => {});
      } catch {
        // The parent went away; there is nobody left to tell.
      }
    };
    const channel = new BroadcastChannel(WATCH_CHANNEL);
    channel.onmessage = (event) => send(event.data);
    channel.unref();
    return send;
  }
  // A user's worker thread. Its `parentPort` belongs to the app, and Node.js
  // 24+ hands a worker's watch messages to `worker.on('message')` as well, so
  // the reports go to the main thread over a channel of their own.
  const channel = new BroadcastChannel(WATCH_CHANNEL);
  channel.unref();
  return (message) => channel.postMessage(message);
}

/**
 * Send what the binding recorded, one URL per message: the watch parent reads a
 * whole array in one `try`, so one bad entry would drop the rest. `oxnode watch`
 * reads the `oxc-node` key to tell these from what Node.js reports (a tsconfig
 * in `node_modules` counts, an imported file there does not); Node.js ignores it.
 * Then the globs the transform expanded, in one `watch:glob` message: the watch
 * parent reads each of its entries on its own.
 *
 * @param {(message: { "watch:import": string[], "oxc-node": true } | { "watch:glob": object[], "oxc-node": true }) => void} sink
 * @param {() => string[]} take the binding's `takeWatchDependencies`
 * @param {() => object[]} [takeGlobs] the binding's `takeWatchGlobs`
 */
export function flush(sink, take, takeGlobs) {
  for (const url of take()) {
    sink({ "watch:import": [url], "oxc-node": true });
  }
  const globs = takeGlobs?.();
  if (Array.isArray(globs) && globs.length > 0) {
    sink({ "watch:glob": globs, "oxc-node": true });
  }
}

/**
 * `fn`, flushing after each call whether it returns, throws or returns a promise.
 * A failed resolve records its candidates and then throws, which is exactly the
 * case that has to be reported. `sink`, `take` and `takeGlobs` are as for `flush`.
 */
export function withFlush(fn, sink, take, takeGlobs) {
  return function (...args) {
    let result;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      flush(sink, take, takeGlobs);
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          flush(sink, take, takeGlobs);
          return value;
        },
        (error) => {
          flush(sink, take, takeGlobs);
          throw error;
        },
      );
    }
    flush(sink, take, takeGlobs);
    return result;
  };
}

/**
 * For `module.register()`: the hooks run on a thread of their own with no
 * `process.send`, so they post into the returned port and the thread that
 * registered them forwards to `sink`. `take` and `takeGlobs` are as for `flush`:
 * what this thread's binding recorded is drained here too, before the process ends.
 */
export function createRelay(sink, take, takeGlobs) {
  const { port1, port2 } = new MessageChannel();
  // Delivers what a failed `import()` the app catches recorded.
  port1.on("message", sink);
  port1.unref();
  // A failed entry import or a `process.exit()` right away ends the process
  // before queued messages are delivered, so read them synchronously.
  const drain = () => {
    let received;
    while ((received = receiveMessageOnPort(port1))) {
      sink(received.message);
    }
    flush(sink, take, takeGlobs);
  };
  process.on("uncaughtExceptionMonitor", drain);
  process.on("exit", drain);
  return port2;
}
