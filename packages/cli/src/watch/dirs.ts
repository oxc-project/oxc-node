import {
  existsSync,
  readdirSync,
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

/** Whether an event for a file is a real change, from its stat before and after. */
export function changed(prev: Sig, next: Sig): boolean {
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
  // a same-size edit within the second looks the same, so it still counts.
  return next.mtimeNs % 1_000_000_000n === 0n;
}

export interface DirWatcherOptions {
  poll: number | false;
  platform: NodeJS.Platform;
  matcher: Pick<Matcher, "classify" | "pruneDir">;
  onChange(path: string): void;
  debug(line: string): void;
  warn(msg: string): void;
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

/**
 * One non-recursive `fs.watch` per folder that holds a wanted file. A file whose folder does
 * not exist yet is watched at the nearest existing ancestor, one level deeper as folders appear.
 * `--include` roots are walked, and new folders in them are walked as they appear.
 */
export class DirWatcher {
  #o: DirWatcherOptions;
  #win: boolean;
  #files = new Map<string, { path: string; sig: Sig }>();
  #byDir = new Map<string, Set<string>>();
  #roots: Root[] = [];
  #walked = new Map<string, WalkedDir>();
  #handles = new Map<string, FSWatcher>();
  // The first missing folder below each placeholder watch: an event for it means "look again".
  #awaited = new Set<string>();
  #failed = new Set<string>();
  #warned = new Set<string>();
  #syncTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #synced = false;
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
  add(file: string): void {
    const k = this.#key(file);
    if (this.#closed || this.#files.has(k)) return;
    this.#files.set(k, { path: file, sig: sigOf(file) });
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
      this.#o.onChange(file);
    });
  }

  /** Walk `base` to `depth` levels for files the matcher accepts, now and as they appear. */
  addRoot(base: string, depth: number): void {
    const root = { base, depth, missing: false };
    this.#roots.push(root);
    if (this.#o.poll === false) this.#scheduleSync();
    else this.#walkRoot(root);
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#syncTimer);
    clearInterval(this.#pollTimer);
    for (const w of this.#handles.values()) w.close();
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
    if (!this.#walked.has(this.#key(root.base))) {
      // Files under a root that shows up later are new; at start they are not.
      this.#walk(root.base, 0, root.depth, root.missing);
    }
    root.missing = false;
    return true;
  }

  #walk(dir: string, level: number, depth: number, fire: boolean) {
    const k = this.#key(dir);
    if (this.#walked.has(k)) return;
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

    for (const [k, w] of this.#handles) {
      if (!needed.has(k)) {
        w.close();
        this.#handles.delete(k);
      }
    }
    const fresh: string[] = [];
    for (const [k, dir] of needed) {
      if (!this.#handles.has(k) && !this.#failed.has(k) && this.#open(k, dir)) fresh.push(dir);
    }
    // A folder that was missing may already hold the files, and no watch saw them arrive.
    if (this.#synced) {
      for (const dir of fresh) this.#checkDir(dir);
    }
    this.#synced = true;
  }

  #open(k: string, dir: string): boolean {
    try {
      const w = watch(dir, (_type, name) => this.#onEvent(dir, name));
      w.on("error", () => {
        // Usually the folder went away: watch its parent instead.
        w.close();
        this.#handles.delete(k);
        this.#scheduleSync();
      });
      this.#handles.set(k, w);
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

  #onEvent(dir: string, name: string | null) {
    if (this.#closed) return;
    // The event type is ignored: macOS reports writes as `rename`.
    if (name === null) {
      this.#checkDir(dir);
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
    if (
      this.#awaited.has(k) ||
      this.#handles.has(k) ||
      this.#walked.has(k) ||
      (name === path.basename(dir) && !existsSync(dir))
    ) {
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

  #checkDir(dir: string) {
    for (const k of this.#byDir.get(this.#key(dir)) ?? []) this.#check(k);
  }

  #check(k: string) {
    const entry = this.#files.get(k)!;
    const next = sigOf(entry.path);
    if (!changed(entry.sig, next)) return;
    entry.sig = next;
    this.#o.onChange(entry.path);
  }
}
