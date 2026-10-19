import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

import { isDirOnDisk as isDir, type Matcher } from "./glob.js";

type Sig = { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } | null;

function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sigOf(p: string): Sig {
  try {
    const s = statSync(p, { bigint: true });
    // A folder where a file was wanted (a literal --include): its walk sees what is in it.
    if (s.isDirectory()) return null;
    return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
  } catch {
    return null;
  }
}

/** The links between a link and the file it ends at: `a -> b -> c -> file` gives `b`, `c`. */
function linkHops(p: string): string[] {
  const hops: string[] = [];
  let cur = p;
  // A loop never ends at a file; realpath has failed for it already.
  for (let n = 0; n < 32; n++) {
    try {
      cur = path.resolve(path.dirname(cur), readlinkSync(cur));
    } catch {
      break;
    }
    if (!isLink(cur)) break;
    hops.push(cur);
  }
  return hops;
}

/** The stat of a link itself: it changes when the link is removed or pointed elsewhere. */
function linkSigOf(p: string): Sig {
  try {
    const s = lstatSync(p, { bigint: true });
    return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
  } catch {
    return null;
  }
}

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

interface Entry {
  path: string;
  shown: string;
  sig: Sig;
  own?: "static" | "run";
  target?: string;
  /** The keys of the links between a link and its target, watched too, as the target is. */
  hops?: string[];
  /** For a link with a target: the link's own stat when it was followed. */
  linkSig?: Sig;
  /** It was there and is gone. */
  gone?: boolean;
  /** Gone, it stays for the next run until it is back: a run that does not find it cannot say. */
  keepGone?: boolean;
  links?: Set<string>;
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
  /**
   * `shown` is the name a change is reported under: a link, for a link's target.
   * `own`: wanted itself, for the whole session or only by the current run's imports.
   * `target` is the key of the file a link points to; `links`, the keys of the links a target is
   * watched for.
   */
  #files = new Map<string, Entry>();
  #byDir = new Map<string, Set<string>>();
  #roots: Root[] = [];
  #walked = new Map<string, WalkedDir>();
  #handles = new Map<string, Handle>();
  // The first missing folder below each placeholder watch: an event for it means "look again".
  #awaited = new Set<string>();
  // The folders of the files the last `dropRun` dropped, still watched for one run: the next run
  // likely imports them again, and on macOS each close and open restarts the FSEvents stream.
  #dropped: string[] = [];
  // Their stats then, so a change made before the new run reports them again is not lost.
  #droppedSigs = new Map<string, Sig>();
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

  /**
   * Watch one file, which may not exist yet. `run`: only the current run's imports want it, so
   * `dropRun` drops it. `keepGone`: once deleted, it stays until it is back, for a file the next
   * run looks for but cannot report (a discovered tsconfig.json). A link's target is watched for
   * as long as the link points to it.
   */
  add(file: string, run = false, keepGone = false): void {
    const have = this.#files.get(this.#key(file));
    if (have) {
      // Wanted itself now, not only as a link's target: kept whatever the links do.
      if (have.own !== "static") have.own = run ? "run" : "static";
      have.shown = file;
      if (keepGone) have.keepGone = true;
      return;
    }
    if (this.#closed) return;
    const entry = this.#put(file, file, run ? "run" : "static");
    if (keepGone) entry.keepGone = true;
    if (isLink(file)) this.#follow(entry);
  }

  /** Drop what only the last run's imports wanted: the next run reports its own. */
  dropRun(): void {
    const dirs = new Set<string>();
    const sigs = new Map<string, Sig>();
    for (const [k, f] of this.#files) {
      if (f.own !== "run") continue;
      // The next run may not report a file it did not find (a deleted tsconfig.json is looked for,
      // not read), so creating it again must still restart. A deleted import is reported again
      // by the failed resolve, while the app still imports it.
      if (f.gone && f.keepGone) continue;
      f.own = undefined;
      const [link] = f.links ?? [];
      if (link !== undefined) {
        f.shown = this.#files.get(link)?.path ?? f.shown;
        continue;
      }
      sigs.set(k, f.sig);
      this.#remove(k);
      dirs.add(path.dirname(f.path));
    }
    this.#droppedSigs = sigs;
    // The folders dropped the time before may be unneeded now.
    if (this.#dropped.length > 0 && this.#o.poll === false) this.#scheduleSync();
    this.#dropped = [...dirs];
  }

  #put(file: string, shown: string, own: Entry["own"]): Entry {
    const k = this.#key(file);
    const entry: Entry = { path: file, shown, sig: sigOf(file), own };
    this.#files.set(k, entry);
    // Dropped at the restart and changed since: the new run may have read it before the change.
    if (this.#droppedSigs.has(k)) {
      const before = this.#droppedSigs.get(k)!;
      this.#droppedSigs.delete(k);
      if (changed(before, entry.sig, false)) {
        queueMicrotask(() => this.#closed || this.#o.onChange(shown));
      }
    }
    const dk = this.#key(path.dirname(file));
    const set = this.#byDir.get(dk);
    if (set) set.add(k);
    else this.#byDir.set(dk, new Set([k]));
    this.#o.debug(`watch ${file}`);
    if (this.#o.poll === false) {
      this.#scheduleSync();
      return entry;
    }
    // The same check as for an event, so a link's target is followed here too.
    watchFile(file, { interval: this.#o.poll, bigint: true }, () => {
      if (this.#files.has(k)) this.#check(k);
    });
    return entry;
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
    const have = this.#files.get(this.#key(file));
    if (have?.own === "static") return;
    try {
      if (!statSync(file).isFile()) return;
    } catch {
      return;
    }
    if (this.#o.matcher.classify(file, "walk") !== "watch") return;
    this.add(file);
    // Known from the imports or as a link's target: the walk keeps it now, and it is no change.
    if (have) return;
    this.#follow(this.#files.get(this.#key(file))!);
    if (fire) this.#o.onChange(file);
  }

  // An edit to a link's target elsewhere fires no event in the link's folder, so watch the target,
  // in place of the one it pointed to before.
  #follow(entry: Entry) {
    let real: string | undefined;
    try {
      real = realpathSync.native(entry.path);
    } catch {}
    const next = real && this.#key(real) !== this.#key(entry.path) ? this.#key(real) : undefined;
    entry.linkSig = next ? linkSigOf(entry.path) : undefined;
    // Pointing a link in the middle of a chain elsewhere changes neither end: so watch those too.
    const hops = next ? linkHops(entry.path).filter((h) => this.#key(h) !== next) : [];
    const hopKeys = hops.map((h) => this.#key(h));
    if (next === entry.target && hopKeys.join("\0") === (entry.hops ?? []).join("\0")) return;
    const link = this.#key(entry.path);
    for (const k of entry.hops ?? []) this.#release(k, link);
    if (entry.target !== undefined) this.#release(entry.target, link);
    entry.target = next;
    entry.hops = hopKeys;
    if (real && next && !this.#closed) {
      const target = this.#files.get(next) ?? this.#put(real, entry.path, undefined);
      (target.links ??= new Set()).add(link);
      hops.forEach((h, i) => {
        const hop = this.#files.get(hopKeys[i]) ?? this.#put(h, entry.path, undefined);
        (hop.links ??= new Set()).add(link);
      });
    }
  }

  // Dropped once neither it nor a link wants it; until then, reported under a link that still does.
  #release(k: string, link: string) {
    const target = this.#files.get(k);
    if (!target?.links) return;
    target.links.delete(link);
    if (target.own) return;
    const [rest] = target.links;
    if (rest === undefined) this.#remove(k);
    else target.shown = this.#files.get(rest)?.path ?? target.shown;
  }

  #remove(k: string) {
    const entry = this.#files.get(k);
    if (!entry) return;
    this.#files.delete(k);
    for (const h of entry.hops ?? []) this.#release(h, k);
    if (entry.target !== undefined) this.#release(entry.target, k);
    this.#byDir.get(this.#key(path.dirname(entry.path)))?.delete(k);
    if (this.#o.poll !== false) unwatchFile(entry.path);
    else this.#scheduleSync();
  }

  #rewalk() {
    // `fs.watchFile` takes its first stat later, on another thread: a change made before that
    // fires nothing. So look again from time to time.
    for (const k of this.#files.keys()) this.#check(k, false);
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
    for (const d of this.#dropped) place(d);
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
    // Not following links, as the first walk: a linked folder is not entered.
    if (isRealDir(full)) {
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
    if (!changed(entry.sig, next, event)) {
      // A link to a deleted file stats as missing, whether the link is still there, gone, or
      // pointed at another missing file. So look at the link itself, or its old target stays.
      if (next === null && entry.target !== undefined) {
        if (changed(entry.linkSig ?? null, linkSigOf(entry.path), false)) this.#follow(entry);
      }
      return;
    }
    if (entry.sig && !next) entry.gone = true;
    else if (next) entry.gone = false;
    entry.sig = next;
    // A link's stat follows it: so a look without an event does not see this change again.
    for (const l of entry.links ?? []) {
      const link = this.#files.get(l);
      if (link) link.sig = sigOf(link.path);
    }
    // A link pointed somewhere else, or removed. Only a link: Windows gives other paths a second
    // spelling (8.3 names), which is the same file.
    if (entry.own && (entry.target !== undefined || isLink(entry.path))) {
      this.#follow(entry);
    }
    // A link in the middle of a chain: the links through it follow it again. A copy, as following
    // takes a link out of the set and puts it back.
    if (entry.links && isLink(entry.path)) {
      for (const l of Array.from(entry.links)) {
        const through = this.#files.get(l);
        if (through) this.#follow(through);
      }
    }
    this.#o.onChange(entry.shown);
  }
}
