import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import { DirWatcher, type DirWatcherOptions } from "../../cli/src/watch/dirs.js";
import { descendants, parseProcStat, parsePs } from "../../cli/src/watch/kill-tree.js";
import { fromOxcNode, parseWatchMessage } from "../../cli/src/watch/messages.js";

const abs = (p: string) => resolve(p);

describe("parseWatchMessage", () => {
  test("not a watch message", () => {
    expect(parseWatchMessage(null)).toBe(null);
    expect(parseWatchMessage("watch:import")).toBe(null);
    expect(parseWatchMessage({ type: "ready" })).toBe(null);
    expect(parseWatchMessage(42)).toBe(null);
  });

  test("what oxc-node reports carries its own key", () => {
    expect(fromOxcNode({ "watch:import": ["file:///x.json"], "oxc-node": true })).toBe(true);
    expect(fromOxcNode({ "watch:import": ["file:///x.json"] })).toBe(false);
    expect(fromOxcNode({ "watch:import": ["file:///x.json"], "oxc-node": "yes" })).toBe(false);
    expect(fromOxcNode(null)).toBe(false);
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
    const opened: { dir: string; emit: (name: string | null) => void; closed: boolean }[] = [];
    // `onOpen` runs before the watch exists: what it does, no event reports.
    let onOpen: ((dir: string) => void) | undefined;
    const watch = ((dir: string, listener: (type: string, name: string | null) => void) => {
      onOpen?.(dir);
      const h = Object.assign(new EventEmitter(), {
        close: () => {
          entry.closed = true;
        },
      });
      const entry = {
        dir,
        emit: (name: string | null) => listener("rename", name),
        closed: false,
      };
      opened.push(entry);
      return h as unknown as FSWatcher;
    }) as unknown as DirWatcherOptions["watch"];
    const open = (dir: string) => opened.filter((h) => h.dir === dir && !h.closed);
    const setOnOpen = (f: typeof onOpen) => {
      onOpen = f;
    };
    return { watch, opened, open, setOnOpen };
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

  test("two roots on one folder: the deeper walk wins", async () => {
    const root = temp();
    const src = join(root, "src");
    mkdirSync(join(src, "deep"), { recursive: true });
    writeFileSync(join(src, "a.ts"), "1");
    writeFileSync(join(src, "deep", "b.json"), "1");
    const { w, debug } = start({ watch: fakeWatch().watch });
    try {
      // `--include 'src/*.ts' --include 'src/**/*.json'`
      w.addRoot(src, 1);
      w.addRoot(src, Infinity);
      await until(() => debug.includes(`watch ${join(src, "deep", "b.json")}`), "the nested file");
      expect(debug).toContain(`watch ${join(src, "a.ts")}`);
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

  test("an event with no file name looks for new files in a walked folder", async () => {
    const root = temp();
    const conf = join(root, "conf");
    mkdirSync(conf);
    writeFileSync(join(conf, "a.json"), "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.addRoot(conf, Infinity);
      await until(() => fake.open(conf).length === 1, "the watch");
      writeFileSync(join(conf, "b.json"), "1");
      fake.open(conf)[0].emit(null);
      expect(changes).toEqual([join(conf, "b.json")]);
    } finally {
      w.close();
    }
  });

  test("a change made before the first watch opens is not lost", async () => {
    const root = temp();
    const [src, conf] = [join(root, "src"), join(root, "conf")];
    mkdirSync(src);
    mkdirSync(conf);
    const file = join(src, "a.ts");
    writeFileSync(file, "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.add(file);
      w.addRoot(conf, Infinity);
      // After the stat of the file and the walk of the folder, before their watches.
      fake.setOnOpen((dir) => {
        if (dir === src) writeFileSync(file, "22");
        if (dir === conf) writeFileSync(join(conf, "new.json"), "1");
      });
      await until(() => fake.open(src).length === 1 && fake.open(conf).length === 1, "watches");
      expect(changes.sort()).toEqual([file, join(conf, "new.json")].sort());
    } finally {
      w.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "a link in a walked folder pointed at a new target watches that target",
    async () => {
      const root = temp();
      const [config, shared] = [join(root, "config"), join(root, "shared")];
      mkdirSync(config);
      mkdirSync(shared);
      writeFileSync(join(shared, "a.json"), "1");
      writeFileSync(join(shared, "b.json"), "1");
      const link = join(config, "current.json");
      symlinkSync("../shared/a.json", link);
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      try {
        w.addRoot(config, Infinity);
        await until(() => fake.open(config).length === 1, "the folder's watch");
        await until(() => fake.open(shared).length === 1, "the target's watch");
        rmSync(link);
        symlinkSync("../shared/b.json", link);
        fake.open(config)[0].emit("current.json");
        expect(changes).toEqual([link]);
        writeFileSync(join(shared, "b.json"), "22");
        fake.open(shared)[0].emit("b.json");
        expect(changes).toEqual([link, link]);
        // The old target is no longer the link's.
        writeFileSync(join(shared, "a.json"), "22");
        fake.open(shared)[0].emit("a.json");
        expect(changes).toEqual([link, link]);
        // Removed: its last target goes too.
        rmSync(link);
        fake.open(config)[0].emit("current.json");
        expect(changes).toEqual([link, link, link]);
        writeFileSync(join(shared, "b.json"), "333");
        fake.open(shared)[0]?.emit("b.json");
        expect(changes).toEqual([link, link, link]);
      } finally {
        w.close();
      }
    },
  );

  test("a change to a file that is not a link opens no second watch", async () => {
    const root = temp();
    const real = join(root, "real");
    mkdirSync(real);
    // A second spelling of the folder, as Windows' 8.3 names give.
    const alias = join(root, "alias");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const file = join(alias, "x.ts");
    writeFileSync(file, "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.add(file);
      await until(() => fake.open(alias).length === 1, "the watch");
      writeFileSync(file, "22");
      fake.open(alias)[0].emit("x.ts");
      expect(changes).toEqual([file]);
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.opened.filter((h) => !h.closed).map((h) => h.dir)).toEqual([alias]);
    } finally {
      w.close();
    }
  });

  test("a file added to a root right after addRoot, before any watch, is a change", async () => {
    const root = temp();
    const conf = join(root, "conf");
    const later = join(root, "later");
    mkdirSync(conf);
    writeFileSync(join(conf, "a.json"), "1");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.addRoot(conf, Infinity);
      w.addRoot(later, Infinity);
      // The app has started; its watches are not open yet.
      writeFileSync(join(conf, "b.json"), "1");
      mkdirSync(later);
      writeFileSync(join(later, "c.json"), "1");
      await until(() => fake.open(conf).length === 1 && fake.open(later).length === 1, "watches");
      expect(changes.sort()).toEqual([join(conf, "b.json"), join(later, "c.json")].sort());
    } finally {
      w.close();
    }
  });

  test("a linked folder made after the start is not entered, as at the start", async () => {
    const root = temp();
    const [conf, outside] = [join(root, "conf"), join(root, "outside")];
    mkdirSync(conf);
    mkdirSync(outside);
    writeFileSync(join(outside, "x.json"), "1");
    const fake = fakeWatch();
    const { w, changes, debug } = start({ platform: "linux", watch: fake.watch });
    try {
      w.addRoot(conf, Infinity);
      await until(() => fake.open(conf).length === 1, "the watch");
      symlinkSync(outside, join(conf, "link"), process.platform === "win32" ? "junction" : "dir");
      fake.open(conf)[0].emit("link");
      await new Promise((r) => setTimeout(r, 100));
      expect(changes).toEqual([]);
      expect(debug.filter((l) => l.includes("x.json"))).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("a folder made where a file was wanted is no change by itself", async () => {
    const root = temp();
    const gen = join(root, "generated");
    const fake = fakeWatch();
    const { w, changes } = start({ platform: "linux", watch: fake.watch });
    try {
      w.add(gen);
      await until(() => fake.open(root).length === 1, "the watch");
      mkdirSync(join(gen, "tmp"), { recursive: true });
      fake.open(root)[0].emit("generated");
      expect(changes).toEqual([]);
    } finally {
      w.close();
    }
  });

  test("a whole-second timestamp counts as a change only after an event", async () => {
    const root = temp();
    const file = join(root, "a.ts");
    writeFileSync(file, "1");
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const fake = fakeWatch();
    // macOS: also looks at every file again once its FSEvents stream restarts.
    const { w, changes } = start({ platform: "darwin", watch: fake.watch });
    try {
      w.add(file);
      await until(() => fake.open(root).length === 1, "the watch");
      await new Promise((r) => setTimeout(r, 400));
      expect(changes).toEqual([]);
      // A same-size edit within the same second looks the same.
      fake.open(root)[0].emit("a.ts");
      expect(changes).toEqual([file]);
    } finally {
      w.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "--poll: a link pointed at a new target stops watching the old one",
    async () => {
      const root = temp();
      const [config, shared] = [join(root, "config"), join(root, "shared")];
      mkdirSync(config);
      mkdirSync(shared);
      const [a, b] = [join(shared, "a.json"), join(shared, "b.json")];
      writeFileSync(a, "1");
      writeFileSync(b, "1");
      const link = join(config, "current.json");
      symlinkSync("../shared/a.json", link);
      const { w, changes, debug } = start({ poll: 20 });
      try {
        w.addRoot(config, Infinity);
        expect(debug).toContain(`watch ${a}`);
        rmSync(link);
        symlinkSync("../shared/b.json", link);
        await until(() => debug.includes(`watch ${b}`), "the new target");
        const seen = changes.length;
        writeFileSync(a, "22");
        await new Promise((r) => setTimeout(r, 300));
        expect(changes).toHaveLength(seen);
        writeFileSync(b, "22");
        await until(() => changes.length > seen, "a change in the new target");
        expect(changes.at(-1)).toBe(link);
      } finally {
        w.close();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a target two links point to stays watched until both are gone",
    async () => {
      const root = temp();
      const [config, shared] = [join(root, "config"), join(root, "shared")];
      mkdirSync(config);
      mkdirSync(shared);
      const target = join(shared, "a.json");
      writeFileSync(target, "1");
      const [one, two] = ["one.json", "two.json"].map((n) => join(config, n));
      symlinkSync("../shared/a.json", one);
      symlinkSync("../shared/a.json", two);
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      const edit = (body: string) => {
        writeFileSync(target, body);
        fake.open(shared)[0]?.emit("a.json");
      };
      try {
        w.addRoot(config, Infinity);
        await until(() => fake.open(shared).length === 1, "the target's watch");
        rmSync(one);
        fake.open(config)[0].emit("one.json");
        expect(changes).toEqual([one]);
        edit("22");
        expect(changes).toEqual([one, two]);
        rmSync(two);
        fake.open(config)[0].emit("two.json");
        edit("333");
        expect(changes).toEqual([one, two, two]);
      } finally {
        w.close();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link removed after its target was deleted lets the old target go",
    async () => {
      const root = temp();
      const [config, shared] = [join(root, "config"), join(root, "shared")];
      mkdirSync(config);
      mkdirSync(shared);
      const target = join(shared, "a.json");
      writeFileSync(target, "1");
      const link = join(config, "current.json");
      symlinkSync("../shared/a.json", link);
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      try {
        w.addRoot(config, Infinity);
        await until(() => fake.open(shared).length === 1, "the target's watch");
        rmSync(target);
        fake.open(shared)[0].emit("a.json");
        expect(changes).toEqual([link]);
        // Still there, the broken link keeps its target: recreating it is a change.
        writeFileSync(target, "2");
        fake.open(shared)[0].emit("a.json");
        expect(changes).toEqual([link, link]);
        rmSync(target);
        fake.open(shared)[0].emit("a.json");
        // Now the link goes too; it stats as missing before and after.
        rmSync(link);
        fake.open(config)[0].emit("current.json");
        const seen = changes.length;
        writeFileSync(target, "3");
        fake.open(shared)[0]?.emit("a.json");
        expect(changes).toHaveLength(seen);
      } finally {
        w.close();
      }
    },
  );

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

  describe("dropRun", () => {
    test("a file changed between the drop and the new run's report is a change", async () => {
      const root = temp();
      const [dep, same] = [join(root, "dep.ts"), join(root, "same.ts")];
      writeFileSync(dep, "1");
      writeFileSync(same, "1");
      const { w, changes } = start({ platform: "linux", watch: fakeWatch().watch });
      try {
        w.add(dep, true);
        w.add(same, true);
        w.dropRun();
        // The new run read dep.ts, then it changed, then the run reported it.
        writeFileSync(dep, "22");
        w.add(dep, true);
        w.add(same, true);
        await new Promise((r) => setTimeout(r, 0));
        expect(changes).toEqual([dep]);
        // Only once: a later run starts from what it saw.
        w.dropRun();
        w.add(dep, true);
        await new Promise((r) => setTimeout(r, 0));
        expect(changes).toEqual([dep]);
      } finally {
        w.close();
      }
    });

    test("drops a file only the imports wanted, and the watch on its folder a run later", async () => {
      const root = temp();
      const [gen, src] = [join(root, "gen"), join(root, "src")];
      mkdirSync(gen);
      mkdirSync(src);
      const [dep, main] = [join(gen, "dep.ts"), join(src, "main.ts")];
      writeFileSync(dep, "1");
      writeFileSync(main, "1");
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      try {
        w.add(main);
        w.add(dep, true);
        await until(() => fake.open(gen).length === 1 && fake.open(src).length === 1, "watches");
        const [old] = fake.open(gen);
        w.dropRun();
        writeFileSync(dep, "22");
        old.emit("dep.ts");
        await new Promise((r) => setTimeout(r, 100));
        // Kept for the next run, which likely imports it again.
        expect(old.closed).toBe(false);
        w.dropRun();
        await until(() => old.closed, "the folder's watch to close");
        expect(fake.open(src)).toHaveLength(1);
        writeFileSync(main, "22");
        fake.open(src)[0].emit("main.ts");
        expect(changes).toEqual([main]);
      } finally {
        w.close();
      }
    });

    test.each([
      ["given only", [false]],
      ["given, then imported", [false, true]],
      ["imported, then given", [true, false]],
    ] as const)("keeps a file %s", async (_, runs) => {
      const root = temp();
      const file = join(root, "a.ts");
      writeFileSync(file, "1");
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      try {
        for (const run of runs) w.add(file, run);
        await until(() => fake.open(root).length === 1, "the watch");
        w.dropRun();
        await new Promise((r) => setTimeout(r, 100));
        writeFileSync(file, "22");
        fake.open(root)[0].emit("a.ts");
        expect(changes).toEqual([file]);
      } finally {
        w.close();
      }
    });

    test("keeps a walked file the imports also wanted", async () => {
      const root = temp();
      const conf = join(root, "conf");
      mkdirSync(conf);
      const file = join(conf, "a.json");
      writeFileSync(file, "1");
      const fake = fakeWatch();
      const { w, changes, debug } = start({ platform: "linux", watch: fake.watch });
      try {
        w.add(file, true);
        w.addRoot(conf, Infinity);
        await until(() => fake.open(conf).length === 1, "the watch");
        w.dropRun();
        await new Promise((r) => setTimeout(r, 100));
        writeFileSync(file, "22");
        fake.open(conf)[0].emit("a.json");
        expect(changes).toEqual([file]);
        // Kept, not dropped and found again by the walk.
        expect(debug.filter((l) => l === `watch ${file}`)).toHaveLength(1);
      } finally {
        w.close();
      }
    });

    test.skipIf(process.platform === "win32")(
      "keeps the target of a walked link, also when the imports wanted it",
      async () => {
        const root = temp();
        const [config, shared] = [join(root, "config"), join(root, "shared")];
        mkdirSync(config);
        mkdirSync(shared);
        const target = join(shared, "a.json");
        writeFileSync(target, "1");
        const link = join(config, "current.json");
        symlinkSync("../shared/a.json", link);
        const fake = fakeWatch();
        const { w, changes } = start({ platform: "linux", watch: fake.watch });
        try {
          w.addRoot(config, Infinity);
          w.add(target, true);
          await until(() => fake.open(shared).length === 1, "the target's watch");
          w.dropRun();
          await new Promise((r) => setTimeout(r, 100));
          writeFileSync(target, "22");
          fake.open(shared)[0].emit("a.json");
          // Under the link again, as before the imports wanted it.
          expect(changes).toEqual([link]);
        } finally {
          w.close();
        }
      },
    );

    test.skipIf(process.platform === "win32")(
      "a given link drops its old target when it points elsewhere",
      async () => {
        const root = temp();
        const [config, shared] = [join(root, "config"), join(root, "shared")];
        mkdirSync(config);
        mkdirSync(shared);
        const [a, b] = [join(shared, "a.json"), join(shared, "b.json")];
        writeFileSync(a, "1");
        writeFileSync(b, "1");
        const link = join(config, "current.json");
        symlinkSync("../shared/a.json", link);
        const fake = fakeWatch();
        const { w, changes, debug } = start({ platform: "linux", watch: fake.watch });
        try {
          w.add(link);
          expect(debug).toContain(`watch ${a}`);
          await until(() => fake.open(shared).length === 1, "the target's watch");
          rmSync(link);
          symlinkSync("../shared/b.json", link);
          fake.open(config)[0].emit("current.json");
          expect(changes).toEqual([link]);
          writeFileSync(a, "22");
          fake.open(shared)[0].emit("a.json");
          expect(changes).toEqual([link]);
          writeFileSync(b, "22");
          fake.open(shared)[0].emit("b.json");
          expect(changes).toEqual([link, link]);
        } finally {
          w.close();
        }
      },
    );

    test("Linux: deleting the folder of a file the next run imports again is a change", async () => {
      const root = temp();
      const [cfg, src] = [join(root, "cfg"), join(root, "src")];
      mkdirSync(cfg);
      mkdirSync(src);
      const [opt, main] = [join(cfg, "opt.ts"), join(src, "main.ts")];
      writeFileSync(opt, "1");
      writeFileSync(main, "1");
      const fake = fakeWatch();
      const { w, changes } = start({ platform: "linux", watch: fake.watch });
      try {
        w.add(main);
        w.add(opt, true);
        await until(() => fake.open(cfg).length === 1, "the folder's watch");
        w.dropRun();
        // The next run starts, then reports the file.
        await new Promise((r) => setTimeout(r, 60));
        w.add(opt, true);
        rmSync(cfg, { recursive: true });
        for (const h of fake.open(cfg)) h.emit("opt.ts");
        await new Promise((r) => setTimeout(r, 100));
        expect(changes).toEqual([opt]);
      } finally {
        w.close();
      }
    });

    test.skipIf(process.platform === "win32")(
      "macOS: an edit to a link's target, then a rerun, is one change",
      async () => {
        const root = temp();
        const [config, shared, lib] = ["config", "shared", "lib"].map((d) => join(root, d));
        for (const d of [config, shared, lib]) mkdirSync(d);
        const target = join(shared, "a.json");
        writeFileSync(target, "1");
        const link = join(config, "current.json");
        symlinkSync("../shared/a.json", link);
        const dep = join(lib, "dep.ts");
        writeFileSync(dep, "1");
        const fake = fakeWatch();
        const { w, changes } = start({ platform: "darwin", watch: fake.watch });
        try {
          w.add(link);
          w.add(dep, true);
          await until(
            () => fake.open(shared).length === 1 && fake.open(lib).length === 1,
            "watches",
          );
          await new Promise((r) => setTimeout(r, 400));
          writeFileSync(target, "22");
          fake.open(shared)[0].emit("a.json");
          expect(changes).toEqual([link]);
          w.dropRun();
          await new Promise((r) => setTimeout(r, 60));
          w.add(dep, true);
          // Past the look at every file that follows a restart of the FSEvents stream.
          await new Promise((r) => setTimeout(r, 400));
          expect(changes).toEqual([link]);
        } finally {
          w.close();
        }
      },
    );

    test.skipIf(process.platform === "win32")(
      "macOS: an edit to a link's target is not seen again when a new watch opens",
      async () => {
        const root = temp();
        const [config, shared, later] = ["config", "shared", "later"].map((d) => join(root, d));
        for (const d of [config, shared, later]) mkdirSync(d);
        const target = join(shared, "a.json");
        writeFileSync(target, "1");
        const link = join(config, "current.json");
        symlinkSync("../shared/a.json", link);
        const fake = fakeWatch();
        const { w, changes } = start({ platform: "darwin", watch: fake.watch });
        try {
          w.add(link);
          await until(() => fake.open(shared).length === 1, "the target's watch");
          await new Promise((r) => setTimeout(r, 400));
          writeFileSync(target, "22");
          fake.open(shared)[0].emit("a.json");
          expect(changes).toEqual([link]);
          w.add(join(later, "b.ts"));
          await until(() => fake.open(later).length === 1, "the new watch");
          await new Promise((r) => setTimeout(r, 400));
          expect(changes).toEqual([link]);
        } finally {
          w.close();
        }
      },
    );

    test("--poll: a dropped file is no longer polled", async () => {
      const root = temp();
      const [dep, main] = [join(root, "dep.ts"), join(root, "main.ts")];
      writeFileSync(dep, "1");
      writeFileSync(main, "1");
      const { w, changes } = start({ poll: 20 });
      try {
        w.add(main);
        w.add(dep, true);
        writeFileSync(dep, "22");
        await until(() => changes.includes(dep), "a change while it is polled");
        w.dropRun();
        writeFileSync(dep, "333");
        await new Promise((r) => setTimeout(r, 300));
        writeFileSync(main, "22");
        await until(() => changes.includes(main), "a change in the kept file");
        expect(changes).toEqual([dep, main]);
      } finally {
        w.close();
      }
    });
  });
});
