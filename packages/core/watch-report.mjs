// Watch mode (`node --watch`, `oxnode watch`) restarts on the files the child
// reports over IPC as `{ "watch:import": [url] }`. Node.js reports the modules
// it loads; this reports what only oxc-node knows: the tsconfig files it read
// and the paths a failed resolve looked for (issue #450).
import { isMainThread, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

import { takeWatchDependencies } from "./index.js";

const WATCH_CHANNEL = "@oxc-node/core:watch-deps";

/**
 * Where this thread sends its reports, or `null` when nobody is watching. With
 * `null` nothing is wrapped, opened or listened to.
 *
 * @returns {((message: { "watch:import": string[] }) => void) | null}
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
      const url = message?.["watch:import"]?.[0];
      if (typeof url !== "string" || seen.has(url) || !process.connected) {
        return;
      }
      seen.add(url);
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
 * whole array in one `try`, so one bad entry would drop the rest.
 */
export function flush(sink) {
  for (const url of takeWatchDependencies()) {
    sink({ "watch:import": [url] });
  }
}

/**
 * `fn`, flushing after each call whether it returns, throws or returns a promise.
 * A failed resolve records its candidates and then throws, which is exactly the
 * case that has to be reported.
 */
export function withFlush(fn, sink) {
  return function (...args) {
    let result;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      flush(sink);
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          flush(sink);
          return value;
        },
        (error) => {
          flush(sink);
          throw error;
        },
      );
    }
    flush(sink);
    return result;
  };
}

/**
 * For `module.register()`: the hooks run on a thread of their own with no
 * `process.send`, so they post into the returned port and the thread that
 * registered them forwards to `sink`.
 */
export function createRelay(sink) {
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
    flush(sink);
  };
  process.on("uncaughtExceptionMonitor", drain);
  process.on("exit", drain);
  return port2;
}
