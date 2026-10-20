/**
 * Ack each SIGINT on the socket named in `OXNODE_SIGNAL_ACK`, while the app listens for
 * SIGINT itself, so the watcher does not forward a Ctrl+C the app already got. A no-op
 * when the variable is unset; it is removed from `process.env` either way. Call it once,
 * on the main thread, before the app's code runs.
 */
export declare function installSignalAck(): void;
