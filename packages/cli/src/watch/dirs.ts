import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type BigIntStats,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

import { isDirOnDisk as isDir, type Matcher } from "./glob.js";

type Sig = { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } | null;

function sigOf(p: string): Sig {
  try {
    const s = statSync(p, { bigint: true });
    return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
  } catch {
    return null;
  }
}

// `fs.watchFile` reports a missing file as all zeros.
const sigOfStats = (s: BigIntStats): Sig =>
  s.ino === 0n && s.mtimeNs === 0n
    ? null
    : { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };

/**
 * Whether a file changed, from its stat before and after. `event`: an event named it, rather
 * than a look made without one.
 */
export function changed(prev: Sig, next: Sig, event = true): boolean {
  if (!prev || !next) return prev !== next;
  if (
    prev.ino !== next.ino ||
    prev.size !== next.size ||
    prev.mtimeNs !== next.mtimeNs ||
    prev.ctimeNs !== next.ctimeNs
  ) {
    return true;
  }
  // Nothing moved: FSEvents replays old events. With whole-second timestamps, though,
  // a same-size edit within the second looks the same, so after an event it still counts.
  return event && next.mtimeNs % 1_000_000_000n === 0n;
}

export interface DirWatcherOptions {
  poll: number | false;
  platform: NodeJS.Platform;
  matcher: Pick<Matcher, "classify" | "pruneDir">;
  onChange(path: string): void;
  debug(line: string): void;
  warn(msg: string): void;
  /** `fs.watch`, replaced in tests. */
  watch?: typeof watch;
}

interface Root {
  base: string;
  depth: number;
  missing: boolean;
}

interface WalkedDir {
  dir: string;
  depth: number;
  level: number;
}

interface Handle {
  w: FSWatcher;
  dir: string;
  /** The folder's identity when the watch was opened: a new one means the folder was replaced. */
  id: string | undefined;
}

// The inode and the birth time: ext4 gives a folder made right after `rm -rf` the old inode number.
function idOf(dir: string): string | undefined {
  try {
    const s = statSync(dir, { bigint: true });
    return `${s.ino}:${s.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

/**
 * One non-recursive `fs.watch` per folder that holds a wanted file. A file whose folder does
 * not exist yet is watched at the nearest existing ancestor, one level deeper as folders appear.
 * `--include` roots are walked, and new folders in them are walked as they appear.
 */
export class DirWatcher {
  #o: DirWatcherOptions;
  #win: boolean;
  /** `shown` is the name a change is reported under: the link, for a link's target. */
  #files = new Map<string, { path: string; shown: string; sig: Sig }>();
  #byDir = new Map<string, Set<string>>();
  #roots: Root[] = [];
  #walked = new Map<string, WalkedDir>();
  #handles = new Map<string, Handle>();
  // The first missing folder below each placeholder watch: an event for it means "look again".
  #awaited = new Set<string>();
  #failed = new Set<string>();
  #warned = new Set<string>();
  #syncTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #settleTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(o: DirWatcherOptions) {
    this.#o = o;
    this.#win = o.platform === "win32";
    if (o.poll !== false) {
      // Polling sees new files only by walking again.
      this.#pollTimer = setInterval(() => this.#rewalk(), o.poll * 10);
    }
  }

  #key(p: string): string {
    return this.#win ? p.toLowerCase() : p;
  }

  /** Watch one file, which may not exist yet. */
  add(file: string, shown = file): void {
    const k = this.#key(file);
    if (this.#closed || this.#files.has(k)) return;
    this.#files.set(k, { path: file, shown, sig: sigOf(file) });
    const dk = this.#key(path.dirname(file));
    const set = this.#byDir.get(dk);
    if (set) set.add(k);
    else this.#byDir.set(dk, new Set([k]));
    this.#o.debug(`watch ${file}`);
    if (this.#o.poll === false) {
      this.#scheduleSync();
      return;
    }
    watchFile(file, { interval: this.#o.poll, bigint: true }, (curr) => {
      const entry = this.#files.get(k)!;
      const next = sigOfStats(curr);
      if (!changed(entry.sig, next)) return;
      entry.sig = next;
      this.#o.onChange(shown);
    });
  }

  /** Walk `base` to `depth` levels for files the matcher accepts, now and as they appear. */
  addRoot(base: string, depth: number): void {
    const root = { base, depth, missing: false };
    this.#roots.push(root);
    // Now, before the app starts: what arrives from here on is a change, found when the watch opens.
    this.#walkRoot(root);
    if (this.#o.poll === false) this.#scheduleSync();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#syncTimer);
    clearInterval(this.#pollTimer);
    clearTimeout(this.#settleTimer);
    for (const h of this.#handles.values()) h.w.close();
    this.#handles.clear();
    if (this.#o.poll !== false) {
      for (const f of this.#files.values()) unwatchFile(f.path);
    }
  }

  #scheduleSync() {
    // Batched: on macOS each new folder watch restarts libuv's single FSEvents stream.
    if (!this.#syncTimer && !this.#closed) {
      this.#syncTimer = setTimeout(() => this.#sync(), 20);
    }
  }

  #walkRoot(root: Root) {
    if (!isDir(root.base)) {
      root.missing = true;
      return false;
    }
    // Files under a root that shows up later are new; at start they are not.
    this.#walk(root.base, 0, root.depth, root.missing);
    root.missing = false;
    return true;
  }

  #walk(dir: string, level: number, depth: number, fire: boolean) {
    const k = this.#key(dir);
    const seen = this.#walked.get(k);
    // Roots can share folders (`src/*.ts` and `src/**/*.json`): the deeper walk wins.
    if (seen && seen.depth - seen.level >= depth - level) return;
    this.#walked.set(k, { dir, depth, level });
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Linked folders are not entered, so a link cannot make a loop.
      if (e.isDirectory()) {
        if (level + 1 < depth && !this.#o.matcher.pruneDir(full))
          this.#walk(full, level + 1, depth, fire);
      } else {
        this.#found(full, fire);
      }
    }
  }

  #found(file: string, fire: boolean) {
    if (this.#files.has(this.#key(file))) return;
    try {
      if (!statSync(file).isFile()) return;
    } catch {
      return;
    }
    if (this.#o.matcher.classify(file, "walk") !== "watch") return;
    this.add(file);
    // An edit to a link's target elsewhere fires no event in the link's folder.
    try {
      const real = realpathSync.native(file);
      if (real !== file) this.add(real, file);
    } catch {}
    if (fire) this.#o.onChange(file);
  }

  #rewalk() {
    this.#walked.clear();
    for (const root of this.#roots) {
      // Known files are skipped, so only new ones count as changes.
      root.missing = true;
      this.#walkRoot(root);
    }
  }

  #sync() {
    this.#syncTimer = undefined;
    if (this.#closed) return;
    const exists = new Map<string, boolean>();
    const cachedExists = (d: string) => {
      let e = exists.get(d);
      if (e === undefined) exists.set(d, (e = existsSync(d)));
      return e;
    };
    const needed = new Map<string, string>();
    const awaited = new Set<string>();
    const place = (dir: string) => {
      let d = dir;
      let below: string | undefined;
      while (!cachedExists(d)) {
        const up = path.dirname(d);
        if (up === d) return;
        below = d;
        d = up;
      }
      if (below) awaited.add(this.#key(below));
      needed.set(this.#key(d), d);
    };

    for (const [k, w] of this.#walked) {
      if (!existsSync(w.dir)) this.#walked.delete(k);
    }
    for (const root of this.#roots) {
      if (!this.#walkRoot(root)) place(root.base);
    }
    for (const f of this.#files.values()) place(path.dirname(f.path));
    for (const [k, w] of this.#walked) needed.set(k, w.dir);
    this.#awaited = awaited;

    for (const [k, h] of this.#handles) {
      // A folder replaced by another (a rename over it) keeps the old watch on Linux and Windows.
      if (!needed.has(k) || idOf(h.dir) !== h.id) this.#drop(k, h);
    }
    const fresh: string[] = [];
    for (const [k, dir] of needed) {
      if (!this.#handles.has(k) && !this.#failed.has(k) && this.#open(k, dir)) fresh.push(dir);
    }
    // Files may have changed or arrived before the watch was open: after the stat or walk at
    // start, or while a folder was missing or replaced.
    for (const dir of fresh) {
      this.#checkDir(dir, false);
      const walked = this.#walked.get(this.#key(dir));
      if (walked) this.#rescan(walked);
    }
  }

  #drop(k: string, h: Handle) {
    h.w.close();
    this.#handles.delete(k);
    this.#restarted();
    // macOS may report a removed folder with one event for the folder and none for its files.
    this.#checkDir(h.dir, false);
  }

  // On macOS libuv has one FSEvents stream for all watches, made again from "now" on each open or
  // close: events not yet delivered (it waits up to 50 ms) or sent meanwhile are lost.
  // So look at every file again once the new stream runs.
  #restarted() {
    if (this.#o.platform !== "darwin" || this.#closed) return;
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = undefined;
      for (const k of this.#files.keys()) this.#check(k, false);
      this.#scheduleSync();
    }, 250);
  }

  #rescan(walked: WalkedDir) {
    let entries;
    try {
      entries = readdirSync(walked.dir);
    } catch {
      return;
    }
    for (const name of entries) this.#onWalkedEntry(walked, path.join(walked.dir, name));
  }

  #open(k: string, dir: string): boolean {
    try {
      const id = idOf(dir);
      const w = (this.#o.watch ?? watch)(dir, (_type, name) => this.#onEvent(dir, w, name));
      const h = { w, dir, id };
      w.on("error", () => {
        // Usually the folder went away: watch its parent instead.
        if (this.#handles.get(k) === h) this.#drop(k, h);
        else w.close();
        this.#scheduleSync();
      });
      this.#handles.set(k, h);
      this.#restarted();
      this.#o.debug(`ready ${dir}`);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      if (code === "ENOENT") {
        this.#scheduleSync();
        return false;
      }
      this.#failed.add(k);
      if (!this.#warned.has(code)) {
        this.#warned.add(code);
        const hint =
          code === "ENOSPC" || code === "EMFILE"
            ? " — raise fs.inotify.max_user_watches, or use --poll"
            : "";
        this.#o.warn(`cannot watch ${dir}: ${code}${hint}`);
      }
      return false;
    }
  }

  #onEvent(dir: string, w: FSWatcher, name: string | null) {
    if (this.#closed) return;
    // The event type is ignored: macOS reports writes as `rename`.
    if (name === null) {
      // No name (allowed by Node): any file here may have changed, or a new one arrived.
      this.#checkDir(dir);
      const walked = this.#walked.get(this.#key(dir));
      if (walked) this.#rescan(walked);
      this.#scheduleSync();
      return;
    }
    const full = path.join(dir, name);
    const k = this.#key(full);
    if (this.#files.has(k)) {
      this.#check(k);
    } else {
      const walked = this.#walked.get(this.#key(dir));
      if (walked) this.#onWalkedEntry(walked, full);
    }
    if (this.#awaited.has(k) || this.#handles.has(k) || this.#walked.has(k)) {
      this.#scheduleSync();
    }
    // An event named after the folder, and not for a child of that name, is for the folder itself:
    // it was removed, moved or replaced. The sync moves or reopens the watch.
    if (name === path.basename(dir) && !this.#files.has(k) && !existsSync(full)) {
      const dk = this.#key(dir);
      const h = this.#handles.get(dk);
      // inotify watches the inode, so the watch is dead even if a new folder (maybe with the
      // same inode number) is already there.
      if (h?.w === w && this.#o.platform === "linux") this.#drop(dk, h);
      this.#scheduleSync();
    }
    // After `rm -rf` and `mkdir`, the watch is on the old folder (Linux, Windows) and sees nothing
    // more. inotify reports the folder itself only once no process uses it (a shell `cd`'d into
    // it), and Windows names it by its full path. So compare the folder on any event, and again at
    // the sync when an entry went away: the folder may be going too.
    const dk = this.#key(dir);
    const h = this.#handles.get(dk);
    if (h?.w !== w) return;
    if (idOf(dir) !== h.id) {
      this.#drop(dk, h);
      this.#scheduleSync();
    } else if (!existsSync(full)) {
      this.#scheduleSync();
    }
  }

  #onWalkedEntry(walked: WalkedDir, full: string) {
    if (isDir(full)) {
      if (walked.level + 1 < walked.depth && !this.#o.matcher.pruneDir(full)) {
        this.#walk(full, walked.level + 1, walked.depth, true);
        this.#scheduleSync();
      }
    } else {
      this.#found(full, true);
    }
  }

  #checkDir(dir: string, event = true) {
    for (const k of this.#byDir.get(this.#key(dir)) ?? []) this.#check(k, event);
  }

  #check(k: string, event = true) {
    const entry = this.#files.get(k)!;
    const next = sigOf(entry.path);
    if (!changed(entry.sig, next, event)) return;
    entry.sig = next;
    // A link pointed somewhere else: watch the new target too. Only a link: Windows gives other
    // paths a second spelling (8.3 names), which is the same file.
    if (entry.shown === entry.path) {
      try {
        if (lstatSync(entry.path).isSymbolicLink()) {
          const real = realpathSync.native(entry.path);
          if (this.#key(real) !== k) this.add(real, entry.path);
        }
      } catch {}
    }
    this.#o.onChange(entry.shown);
  }
}
