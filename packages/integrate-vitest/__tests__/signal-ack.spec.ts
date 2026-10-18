import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

/**
 * Ctrl+C signals the whole process group, so an app run by oxnode already has
 * the SIGINT oxnode would forward to it. register.mjs tells oxnode so by
 * writing "I" to the socket in OXNODE_SIGNAL_ACK, but only while the app
 * listens for SIGINT itself, and without the app seeing the extra listener.
 * This stands in for oxnode's side.
 */
const CORE = dirname(fileURLToPath(new URL("../../core/register.mjs", import.meta.url)));
const REGISTER = ["--import", pathToFileURL(join(CORE, "register.mjs")).href];

const ENV = {
  ...process.env,
  NODE_OPTIONS: undefined,
  OXC_LOG: undefined,
  OXNODE_SIGNAL_ACK: undefined,
  WATCH_REPORT_DEPENDENCIES: undefined,
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
  }
});

function app(source: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oxc-node-signal-ack-")));
  roots.push(root);
  writeFileSync(join(root, "app.mjs"), source);
  return root;
}

interface Acks {
  server: Server;
  path: string;
  connections: Socket[];
  /** Every byte received, on every connection. */
  received(): string;
  connected(): Promise<void>;
  /** Resolves once every connection has closed. */
  closed(): Promise<void>;
}

function listen(): Promise<Acks> {
  // Short enough for the 104-byte limit on a unix socket path.
  const path = join(tmpdir(), `oxnode-test-${randomBytes(4).toString("hex")}.sock`);
  const connections: Socket[] = [];
  let data = "";
  let onConnection = () => {};
  const server = createServer((socket) => {
    connections.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    onConnection();
  });
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        server,
        path,
        connections,
        received: () => data,
        connected: () =>
          connections.length > 0
            ? Promise.resolve()
            : new Promise<void>((done) => (onConnection = done)),
        closed: () =>
          Promise.all(
            connections.map(
              (socket) =>
                new Promise<void>((done) =>
                  socket.closed ? done() : socket.on("close", () => done()),
                ),
            ),
          ).then(() => {}),
      }),
    );
  });
}

function start(root: string, env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [...REGISTER, "./app.mjs"], {
    cwd: root,
    env: { ...ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: [RegExp, () => void][] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const [re, done] of waiters.splice(0)) {
      if (re.test(stdout)) {
        done();
      } else {
        waiters.push([re, done]);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  void exited.then(() => clearTimeout(timer));
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor: (re: RegExp) =>
      re.test(stdout) ? Promise.resolve() : new Promise<void>((done) => waiters.push([re, done])),
  };
}

describe.skipIf(process.platform === "win32")("the SIGINT ack", () => {
  test("acks each SIGINT while the app listens, and hides the extra listener", async () => {
    const acks = await listen();
    try {
      const root = app(
        [
          "let count = 0;",
          'process.on("SIGINT", () => {',
          "  count += 1;",
          '  console.log("got " + count);',
          "  if (count === 2) process.exit(7);",
          "});",
          'const counts = [process.listenerCount("SIGINT"), process.listeners("SIGINT").length,',
          '  process.rawListeners("SIGINT").length];',
          'console.log("env " + typeof process.env.OXNODE_SIGNAL_ACK);',
          'console.log("ready " + counts.join(" "));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      const run = start(root, { OXNODE_SIGNAL_ACK: acks.path });
      await run.waitFor(/ready/);
      await acks.connected();
      run.child.kill("SIGINT");
      await run.waitFor(/got 1/);
      run.child.kill("SIGINT");
      expect(await run.exited).toEqual({ code: 7, signal: null });
      await acks.closed();
      expect(acks.received()).toBe("II");
      expect(acks.connections).toHaveLength(1);
      expect(run.stdout()).toContain("ready 1 1 1\n");
      // Not inherited by what the app spawns.
      expect(run.stdout()).toContain("env undefined\n");
    } finally {
      acks.server.close();
    }
  });

  test("an app with no SIGINT listener never acks and dies by SIGINT", async () => {
    const acks = await listen();
    try {
      const root = app('console.log("ready");\nsetInterval(() => {}, 1000);\n');
      const run = start(root, { OXNODE_SIGNAL_ACK: acks.path });
      await run.waitFor(/ready/);
      run.child.kill("SIGINT");
      expect(await run.exited).toEqual({ code: null, signal: "SIGINT" });
      expect(acks.connections).toHaveLength(0);
      expect(acks.received()).toBe("");
    } finally {
      acks.server.close();
    }
  });

  test("a signal-exit style app that re-raises still dies by SIGINT", async () => {
    const acks = await listen();
    try {
      // What signal-exit does: when its handler is the only listener left, it
      // removes it and sends the signal again, so the default ends the process.
      const root = app(
        [
          "const handler = () => {",
          '  if (process.listeners("SIGINT").length === 1) {',
          '    process.removeListener("SIGINT", handler);',
          '    console.log("re-raising " + process.listenerCount("SIGINT"));',
          '    process.kill(process.pid, "SIGINT");',
          "  }",
          "};",
          'process.on("SIGINT", handler);',
          'console.log("ready " + process.listenerCount("SIGINT"));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      const run = start(root, { OXNODE_SIGNAL_ACK: acks.path });
      await run.waitFor(/ready/);
      await acks.connected();
      run.child.kill("SIGINT");
      expect(await run.exited).toEqual({ code: null, signal: "SIGINT" });
      await acks.closed();
      expect(acks.received()).toBe("I");
      expect(run.stdout()).toBe("ready 1\nre-raising 0\n");
    } finally {
      acks.server.close();
    }
  });

  test("the ack does not count toward the listener limit", async () => {
    const acks = await listen();
    try {
      // Plain Node.js warns only past ten SIGINT listeners, the default limit.
      const source = (count: number, before = "") =>
        [
          before,
          `for (let i = 0; i < ${count}; i++) process.on("SIGINT", () => {});`,
          'console.log("ready " + process.listenerCount("SIGINT") + " " + process.getMaxListeners());',
          "setTimeout(() => process.exit(0), 50);",
          "",
        ].join("\n");
      const ten = start(app(source(10)), { OXNODE_SIGNAL_ACK: acks.path });
      expect(await ten.exited).toEqual({ code: 0, signal: null });
      expect(ten.stdout()).toBe("ready 10 10\n");
      expect(ten.stderr()).not.toContain("MaxListenersExceededWarning");

      // A limit the app sets itself, before or after the ack is in.
      const set = start(app(source(20, "process.setMaxListeners(20);")), {
        OXNODE_SIGNAL_ACK: acks.path,
      });
      expect(await set.exited).toEqual({ code: 0, signal: null });
      expect(set.stdout()).toBe("ready 20 20\n");
      expect(set.stderr()).not.toContain("MaxListenersExceededWarning");
      const later = start(
        app(
          ['process.on("SIGINT", () => {});', "process.setMaxListeners(20);", source(19)].join(
            "\n",
          ),
        ),
        { OXNODE_SIGNAL_ACK: acks.path },
      );
      expect(await later.exited).toEqual({ code: 0, signal: null });
      expect(later.stdout()).toBe("ready 20 20\n");
      expect(later.stderr()).not.toContain("MaxListenersExceededWarning");

      // One past the limit still warns, as it does without oxnode.
      const eleven = start(app(source(11)), { OXNODE_SIGNAL_ACK: acks.path });
      expect(await eleven.exited).toEqual({ code: 0, signal: null });
      expect(eleven.stdout()).toBe("ready 11 10\n");
      expect(eleven.stderr()).toContain("MaxListenersExceededWarning");

      // Once the ack is out, the limit is back where it was.
      const removed = start(
        app(
          [
            'process.on("SIGINT", () => {});',
            'process.removeAllListeners("SIGINT");',
            'for (let i = 0; i < 11; i++) process.on("exit", () => {});',
            'console.log("ready " + process.getMaxListeners());',
            "",
          ].join("\n"),
        ),
        { OXNODE_SIGNAL_ACK: acks.path },
      );
      expect(await removed.exited).toEqual({ code: 0, signal: null });
      expect(removed.stdout()).toBe("ready 10\n");
      expect(removed.stderr()).toContain("11 exit listeners added");
    } finally {
      acks.server.close();
    }
  });

  test("without OXNODE_SIGNAL_ACK nothing changes", async () => {
    const root = app(
      [
        'process.on("SIGINT", () => {});',
        'console.log("ready " + process.listenerCount("SIGINT") + " " + process.rawListeners("SIGINT").length);',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const run = start(root, {});
    expect(await run.exited).toEqual({ code: 0, signal: null });
    expect(run.stdout()).toBe("ready 1 1\n");
  });
});
