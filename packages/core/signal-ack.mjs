// oxnode forwards a SIGINT it gets to the app, because `kill -INT <oxnode pid>`
// reaches oxnode alone. Ctrl+C, though, signals the whole process group, so
// the app already has it, and forwarding would deliver it twice. The app tells
// oxnode it got one by writing "I" to the socket named in OXNODE_SIGNAL_ACK;
// oxnode forwards only when no such ack arrives.
import { connect } from "node:net";

/**
 * Ack every SIGINT this process gets, for as long as the app listens for SIGINT
 * itself. An app that does not keeps Node.js' default and dies on the signal,
 * so there is nothing to ack, and the extra listener must not keep it alive.
 *
 * A no-op unless OXNODE_SIGNAL_ACK is set. Call it on the main thread only.
 */
export function installSignalAck() {
  const path = process.env.OXNODE_SIGNAL_ACK;
  // The socket belongs to the oxnode that spawned this process; the processes
  // the app starts in turn are not its children.
  delete process.env.OXNODE_SIGNAL_ACK;
  if (!path) {
    return;
  }

  let socket = null;
  let installed = false;
  const ack = () => {
    socket?.write("I");
  };

  // The ack still counts toward the listener limit, so ten SIGINT listeners of
  // the app's own would warn. The limit is one higher while the ack is in, and
  // reported without it. It is the limit of every event on `process`, so the
  // others get one more listener before Node.js warns.
  const getMaxListeners = process.getMaxListeners.bind(process);
  const setMaxListeners = process.setMaxListeners.bind(process);
  // The limit set for the ack, while it is in and the limit is a finite one.
  let raised = null;
  const raise = () => {
    const max = getMaxListeners();
    raised = max > 0 && Number.isFinite(max) ? max + 1 : null;
    if (raised !== null) {
      setMaxListeners(raised);
    }
  };
  const lower = () => {
    if (raised !== null && getMaxListeners() === raised) {
      setMaxListeners(raised - 1);
    }
    raised = null;
  };

  const install = () => {
    installed = true;
    raise();
    if (!socket) {
      socket = connect(path);
      socket.on("error", () => {
        socket = null;
      });
      socket.unref();
    }
    process.prependListener("SIGINT", ack);
  };

  const listeners = process.listeners.bind(process);
  const rawListeners = process.rawListeners.bind(process);
  const listenerCount = process.listenerCount.bind(process);
  // A `--require` preload may have listened before this ran.
  if (listenerCount("SIGINT") > 0) {
    install();
  }
  process.on("newListener", (event, listener) => {
    if (event === "SIGINT" && listener !== ack && !installed) {
      install();
    }
  });
  process.on("removeListener", (event, listener) => {
    if (event !== "SIGINT") {
      return;
    }
    if (listener === ack) {
      installed = false;
      lower();
      return;
    }
    // Once only the ack is left, remove it too, so Node.js restores the default
    // and the next SIGINT ends the process again.
    const left = rawListeners("SIGINT");
    if (installed && left.length === 1 && left[0] === ack) {
      process.removeListener("SIGINT", ack);
    }
  });

  // Libraries in the signal-exit style re-raise the signal when theirs are the
  // only listeners, so the ack must not be counted.
  const visible = (list) => list.filter((listener) => listener !== ack);
  process.listeners = (event) => {
    const list = listeners(event);
    return event === "SIGINT" ? visible(list) : list;
  };
  process.rawListeners = (event) => {
    const list = rawListeners(event);
    return event === "SIGINT" ? visible(list) : list;
  };
  process.listenerCount = (event, ...rest) => {
    const count = listenerCount(event, ...rest);
    if (event !== "SIGINT" || !installed || rest.length > 0) {
      return count;
    }
    return count - 1;
  };
  process.getMaxListeners = () => {
    const max = getMaxListeners();
    return raised !== null && max === raised ? max - 1 : max;
  };
  process.setMaxListeners = (n) => {
    setMaxListeners(n);
    if (installed) {
      raise();
    }
    return process;
  };
}
