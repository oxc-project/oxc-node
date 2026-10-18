import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import { DirWatcher, type DirWatcherOptions } from "../../cli/src/watch/dirs.js";
import { descendants, parseProcStat, parsePs } from "../../cli/src/watch/kill-tree.js";
import { parseWatchMessage } from "../../cli/src/watch/messages.js";

const abs = (p: string) => resolve(p);

describe("parseWatchMessage", () => {
  test("not a watch message", () => {
    expect(parseWatchMessage(null)).toBe(null);
    expect(parseWatchMessage("watch:import")).toBe(null);
    expect(parseWatchMessage({ type: "ready" })).toBe(null);
    expect(parseWatchMessage(42)).toBe(null);
  });

  test("watch:import file URLs", () => {
    const file = abs("/proj/src/a b#c.ts");
    expect(parseWatchMessage({ "watch:import": [pathToFileURL(file).href] })).toEqual([file]);
  });

  test("watch:require paths, nulls for builtins, and file URLs from an async load hook", () => {
    const a = abs("/proj/a.cts");
    const b = abs("/proj/b.cts");
    expect(parseWatchMessage({ "watch:require": [a, null, pathToFileURL(b).href] })).toEqual([
      a,
      b,
    ]);
  });

  test("one bad entry does not drop the rest", () => {
    const a = abs("/proj/a.ts");
    expect(
      parseWatchMessage({
        "watch:import": [
          "file://host-only-on-windows/x",
          "node:fs",
          "data:text/javascript,1",
          "",
          5,
          "rel/x.ts",
          a,
        ],
      }),
    ).toEqual(process.platform === "win32" ? [expect.any(String), a] : [a]);
  });

  test("a value that is not an array", () => {
    expect(parseWatchMessage({ "watch:import": "file:///x.ts" })).toEqual([]);
    expect(parseWatchMessage({ "watch:require": { 0: "/x" } })).toEqual([]);
  });

  test("both keys in one message", () => {
    const a = abs("/proj/a.cts");
    const b = abs("/proj/b.ts");
    expect(
      parseWatchMessage({ "watch:require": [a], "watch:import": [pathToFileURL(b).href] }),
    ).toEqual([a, b]);
  });
});

describe("kill tree parsers", () => {
  test("/proc/<pid>/stat, with spaces and ) in the name", () => {
    expect(parseProcStat("1234 (node) S 1000 1234 1234 0 -1 4194560 2000 0 0 0")).toEqual({
      pid: 1234,
      ppid: 1000,
    });
    expect(parseProcStat("77 (my (weird) app) R 76 77 77 34816 77 4194304")).toEqual({
      pid: 77,
      ppid: 76,
    });
    expect(parseProcStat("garbage")).toBe(null);
  });

  test("ps -A -o pid=,ppid=", () => {
    const text = "    1     0\n  412     1\n 9001   412\n\n 9002  9001\nbad line\n";
    expect(parsePs(text)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 412, ppid: 1 },
      { pid: 9001, ppid: 412 },
      { pid: 9002, ppid: 9001 },
    ]);
  });

  test("descendants, parents first", () => {
    const table = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 10 },
      { pid: 13, ppid: 11 },
      { pid: 20, ppid: 1 },
    ];
    expect(descendants(table, 10)).toEqual([11, 12, 13]);
    expect(descendants(table, 13)).toEqual([]);
    expect(descendants(table, 99)).toEqual([]);
    // A loop in a bad snapshot ends.
    expect(descendants([...table, { pid: 10, ppid: 13 }], 10)).toEqual([11, 12, 13]);
  });
});

describe("DirWatcher", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "oxc-node-dirwatcher-")));
    temps.push(d);
    return d;
  };
  // As long as the e2e helper waits: FSEvents can take seconds on a slow CI machine.
  const until = async (cond: () => boolean, what: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const start = (extra: Partial<DirWatcherOptions> = {}) => {
    const changes: string[] = [];
    const debug: string[] = [];
    const w = new DirWatcher({
      poll: false,
      platform: process.platform,
      matcher: { classify: () => "watch", pruneDir: () => false },
      onChange: (p) => changes.push(p),
      debug: (l) => debug.push(l),
      warn: () => {},
      ...extra,
    });
    return { w, changes, debug };
  };

  /** Stands in for `fs.watch`: events come only from the test, as from inotify. */
  const fakeWatch = () => {
    const opened: { dir: string; emit: (name: string) => void; closed: boolean }[] = [];
    const watch = ((dir: string, listener: (type: string, name: string | null) => void) => {
      const h = Object.assign(new EventEmitter(), {
        close: () => {
          entry.closed = true;
        },
      });
      const entry = { dir, emit: (name: string) => listener("rename", name), closed: false };
      opened.push(entry);
      return h as unknown as FSWatcher;
    }) as unknown as DirWatcherOptions["watch"];
    const open = (dir: string) => opened.filter((h) => h.dir === dir && !h.closed);
    return { watch, opened, open };
  };

  test("removing a folder is a change for the files in it", async () => {
    const root = temp();
    const files = [0, 1, 2].map((i) => join(root, `cfg${i}`, "a.ts"));
    for (const f of files) {
      mkdirSync(join(f, ".."));
      writeFileSync(f, "1");
    }
    const { w, changes, debug } = start();
    try {
      for (const f of files) w.add(f);
      await until(() => files.every((f) => debug.includes(`ready ${join(f, "..")}`)), "ready");
      // Let FSEvents settle: then macOS reports the removal only for the folder itself.
      await new Promise((r) => setTimeout(r, 500));
      for (const f of files) {
        rmSync(join(f, ".."), { recursive: true });
        await until(() => changes.includes(f), `a change for ${f}`);
      }
    } finally {
      w.close();
    }
  });

  test("Linux: a folder replaced in place gets a new watch", async () => {
    const root = temp();
    const gen = join(root, "gen");
    const file = join(gen, "x.ts");
    mkdirSync(gen);
    writeFileSync(file, "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.add(file);
      await until(() => fake.open(gen).length === 1, "the first watch");
      const [first] = fake.open(gen);
      rmSync(gen, { recursive: true });
      mkdirSync(gen);
      writeFileSync(file, "22");
      // inotify watches the inode: the old watch only sees its own deletion, named after it.
      first.emit("gen");
      await until(() => changes.includes(file), "a change");
      await until(() => fake.open(gen).length === 1, "a new watch");
      expect(first.closed).toBe(true);
      expect(fake.open(gen)[0]).not.toBe(first);
      // The new watch is live.
      writeFileSync(file, "333");
      fake.open(gen)[0].emit("x.ts");
      expect(changes.filter((c) => c === file)).toHaveLength(2);
    } finally {
      w.close();
    }
  });

  test.each(["linux", "win32"] as const)(
    "%s: a folder replaced while a process is in it gets a new watch",
    async (platform) => {
      const root = temp();
      const gen = join(root, "gen");
      const file = join(gen, "x.ts");
      mkdirSync(gen);
      writeFileSync(file, "1");
      const fake = fakeWatch();
      const { w, changes } = start({ platform, watch: fake.watch });
      const open = () => fake.opened.filter((h) => !h.closed);
      try {
        w.add(file);
        await until(() => open().length === 1, "the first watch");
        const [first] = open();
        rmSync(gen, { recursive: true });
        mkdirSync(gen);
        writeFileSync(file, "22");
        // Only the file's removal: inotify holds back the event for the folder itself while a
        // shell is `cd`'d into it, and on ext4 the new folder may get the old inode number.
        first.emit("x.ts");
        await until(() => changes.includes(file), "a change");
        await until(() => open().length === 1 && open()[0] !== first, "a new watch");
        expect(first.closed).toBe(true);
        writeFileSync(file, "333");
        open()[0].emit("x.ts");
        expect(changes.filter((c) => c === file)).toHaveLength(2);
      } finally {
        w.close();
      }
    },
  );

  test("macOS: a change lost while FSEvents restarts is found by a later look", async () => {
    const root = temp();
    const [a, b] = ["cfg0", "cfg1"].map((d) => join(root, d, "a.ts"));
    for (const f of [a, b]) {
      mkdirSync(join(f, ".."));
      writeFileSync(f, "1");
    }
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "darwin", watch: fake.watch });
    try {
      w.add(a);
      w.add(b);
      await until(() => fake.open(join(b, "..")).length === 1, "the first watches");
      rmSync(join(a, ".."), { recursive: true });
      fake.open(join(a, ".."))[0].emit("cfg0");
      // The watch moves to the parent, which restarts libuv's one FSEvents stream.
      await until(() => fake.open(root).length === 1, "the parent's watch");
      // Removed meanwhile: the old stream is gone and the new one starts after it.
      rmSync(join(b, ".."), { recursive: true });
      await until(() => changes.includes(b), "a change for the second folder");
    } finally {
      w.close();
    }
  });

  test("Linux: a walked --include folder replaced in place is walked again", async () => {
    const root = temp();
    const conf = join(root, "conf");
    mkdirSync(conf);
    writeFileSync(join(conf, "a.json"), "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.addRoot(conf, Infinity);
      await until(() => fake.open(conf).length === 1, "the first watch");
      const [first] = fake.open(conf);
      rmSync(conf, { recursive: true });
      mkdirSync(conf);
      writeFileSync(join(conf, "b.json"), "1");
      first.emit("conf");
      await until(() => changes.includes(join(conf, "b.json")), "the new file");
      expect(changes).toContain(join(conf, "a.json"));
    } finally {
      w.close();
    }
  });

  test("a folder swapped by rename gets a new watch, found by its inode", async () => {
    const root = temp();
    const gen = join(root, "gen");
    const file = join(gen, "x.ts");
    mkdirSync(gen);
    writeFileSync(file, "1");
    const fake = fakeWatch();
    // Not Linux: only a new inode makes the watch stale.
    const { w, changes } = start({ platform: "darwin", watch: fake.watch });
    try {
      w.add(file);
      await until(() => fake.open(gen).length === 1, "the first watch");
      const [first] = fake.open(gen);
      // An event named after the folder, with the folder unchanged, keeps the watch.
      first.emit("gen");
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.open(gen)).toEqual([first]);

      mkdirSync(join(root, "gen.tmp"));
      writeFileSync(join(root, "gen.tmp", "x.ts"), "22");
      rmSync(gen, { recursive: true });
      renameSync(join(root, "gen.tmp"), gen);
      first.emit("gen");
      await until(() => changes.includes(file), "a change");
      expect(first.closed).toBe(true);
      await until(() => fake.open(gen).length === 1, "a new watch");
    } finally {
      w.close();
    }
  });
});
