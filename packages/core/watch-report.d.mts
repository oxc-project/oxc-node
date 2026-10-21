import type { MessagePort } from "node:worker_threads";

/** A report of files the watch parent should restart on. */
export interface WatchMessage {
  "watch:import": string[];
  /** Set on what the loader reports itself: a tsconfig it read, a path a failed resolve tried. */
  "oxc-node"?: true;
}

export type WatchSink = (message: WatchMessage) => void;

/** The binding's `takeWatchDependencies`: the URLs recorded since the last call. */
export type TakeWatchDependencies = () => string[];

/**
 * Where this thread sends its reports, or `null` when nobody is watching
 * (`WATCH_REPORT_DEPENDENCIES` is unset, or the main thread has no IPC channel).
 * Call it once per thread and share the result.
 */
export declare function watchSink(): WatchSink | null;

/** Send what the binding recorded, one URL per message, marked `"oxc-node": true`. */
export declare function flush(sink: WatchSink, take: TakeWatchDependencies): void;

/** `fn`, flushing after each call whether it returns, throws or returns a promise. */
export declare function withFlush<F extends (...args: any[]) => any>(
  fn: F,
  sink: WatchSink,
  take: TakeWatchDependencies,
): F;

/**
 * For `module.register()`: a port to pass to the hooks thread, whose reports the
 * calling thread forwards to `sink`. It also drains `take` before the process ends.
 */
export declare function createRelay(sink: WatchSink, take: TakeWatchDependencies): MessagePort;
