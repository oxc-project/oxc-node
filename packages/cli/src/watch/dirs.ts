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
  type BigIntStats,
  type FSWatcher,
} from "node:fs";
import path from "node:path";

import { isDirOnDisk as isDir, type Matcher } from "./glob.js";

type Sig = { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint } | null;

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sigFrom(s: BigIntStats): Sig {
  return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
}

function sigOf(p: string): Sig {
  try {
    const s = statSync(p, { bigint: true });
    // A folder where a file was wanted (a literal --include): its walk sees what is in it.
    if (s.isDirectory()) return null;
    return sigFrom(s);
  } catch {
    return null;
  }
}

/** The stat of a file, through a link: `undefined` when it is no file, or gone. */
function fileSigOf(p: string): Sig | undefined {
  try {
    const s = statSync(p, { bigint: true });
    return s.isFile() ? sigFrom(s) : undefined;
  } catch {
    return undefined;
  }
}

/** The stat of a file a walk or an event came across, taken when an owner first asks for it. */
type FileSig = () => Sig | undefined;

function onceSig(take: FileSig): FileSig {
  let sig: Sig | undefined;
  let taken = false;
  return () => {
    if (!taken) {
      taken = true;
      sig = take();
    }
    return sig;
  };
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
  /**
   * How long a watch no longer needed stays open, in ms, so that it serves again if its folder is
   * wanted again. On macOS a close costs what an open does: 60 s there, 0 elsewhere.
   */
  linger?: number;
}

/**
 * A glob the app reported, watched until the next `dropRun`. Only presence counts: a file that
 * appears in its roots is a change, and so is one that disappears; an edit is not.
 */
export interface GlobWatch {
  /** Folders to walk. `depth` counts levels below `base`: 1 is the files in it. */
  roots: { base: string; depth: number }[];
  /** The files that existed when the app listed them. */
  files?: string[];
  /** Whether a file counts for the glob. */
  counts(file: string): boolean;
  /** Whether the walk skips a folder. */
  prune(absDir: string): boolean;
}

/**
 * Whether a file a walk finds is a change: no, yes, or `"once"`, once for each state over two
 * runs ({@link DirWatcher}'s `#fireOnce`).
 */
type Fire = boolean | "once";

/**
 * What walks a root: the `--include` roots share one owner, and each glob the current run
 * reported is one. Each owner has its own rules for the folders it enters and the files it keeps.
 */
interface Owner {
  /** A glob of the current run: `dropRun` drops its roots and walks. */
  run: boolean;
  /** Whether the walk skips a folder below one of the roots. */
  prune(absDir: string): boolean;
  /** A file the walk came across. `sig` takes its stat; absent, it is known to be no file. */
  found(file: string, fire: Fire, sig?: FileSig): void;
}

interface Root {
  owner: Owner;
  base: string;
  depth: number;
  missing: boolean;
}

interface Entry {
  path: string;
  shown: string;
  sig: Sig;
  /** Wanted itself: for the whole session, or by the current run (its imports or a glob it reported). */
  own?: "static" | "run";
  /** With `own: "run"`: only a glob the run reported wants it, so only its presence counts. */
  presence?: boolean;
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
  /** The owners that walked this folder, each at its own level; the `--include` one first. */
  walks: { owner: Owner; level: number; depth: number }[];
}

interface Handle {
  w: FSWatcher;
  dir: string;
  /** The folder's identity when the watch was opened: a new one means the folder was replaced. */
  id: string | undefined;
  /** macOS: the folder's real path then. FSEvents watches it, so only a new one needs a new watch. */
  real?: string;
  /** Since when it is no longer needed: it closes once `linger` has passed. */
  idle?: number;
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

function realOf(dir: string): string | undefined {
  try {
    return realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/**
 * One non-recursive `fs.watch` per folder that holds a wanted file. A file whose folder does
 * not exist yet is watched at the nearest existing ancestor, one level deeper as folders appear.
 * `--include` roots and the roots of the globs the app reports are walked, and new folders in
 * them are walked as they appear.
 *
 * On macOS a folder's watch stays while the folder is replaced, and for `linger` once it is
 * missing or no longer needed: libuv's FSEvents stream watches the path, not the folder. Each open or close rebuilds
 * that one stream for every watched folder, which leaks memory for each of them (libuv#5283,
 * nodejs/node#67293) and loses events meanwhile (libuv#3866). Only a new real path, a link on
 * the way pointed elsewhere, opens it again.
 */
export class DirWatcher {
  #o: DirWatcherOptions;
  #win: boolean;
  #mac: boolean;
  #linger: number;
  /**
   * `shown` is the name a change is reported under: a link, for a link's target.
   * `own`: wanted itself, for the whole session or only by the current run's imports.
   * `target` is the key of the file a link points to; `links`, the keys of the links a target is
   * watched for.
   */
  #files = new Map<string, Entry>();
  #byDir = new Map<string, Set<string>>();
  // The `--include` roots, then those of the globs the current run reported.
  #roots: Root[] = [];
  #walked = new Map<string, WalkedDir>();
  // The owner of the `--include` roots. It follows links to their targets; a glob does not.
  #static: Owner = {
    run: false,
    prune: (dir) => this.#o.matcher.pruneDir(dir),
    found: (file, fire, sig) => this.#found(file, fire, sig),
  };
  // The files a glob report found changed at once, for this run and the one before: a run that
  // finds the same again must not restart forever.
  #fired = new Set<string>();
  #firedBefore = new Set<string>();
  #handles = new Map<string, Handle>();
  // The first missing folder below each placeholder watch: an event for it means "look again".
  #awaited = new Set<string>();
  // The folders of the files the last `dropRun` dropped, still watched for one run: the next run
  // likely imports them again, and on macOS each close and open restarts the FSEvents stream.
  #dropped: string[] = [];
  // Their stats then, so a change made before the new run reports them again is not lost.
  #droppedSigs = new Map<string, Sig>();
  // Set while dropRun runs: what it removes, also a target released through a dropped link.
  #dropping: { sigs: Map<string, Sig>; dirs: Set<string> } | undefined;
  #failed = new Set<string>();
  #warned = new Set<string>();
  #syncTimer: NodeJS.Timeout | undefined;
  #lingerTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #settleTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(o: DirWatcherOptions) {
    this.#o = o;
    this.#win = o.platform === "win32";
    this.#mac = o.platform === "darwin";
    this.#linger = o.linger ?? (this.#mac ? 60_000 : 0);
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
      // Wanted itself now, not only as a link's target or by a glob: kept whatever the links
      // do, and an edit is a change.
      if (have.own !== "static") have.own = run ? "run" : "static";
      have.presence = false;
      have.shown = file;
      if (keepGone) have.keepGone = true;
      // A hop of another link's chain: its own target was that link's to watch.
      if (have.target === undefined && isLink(file)) this.#follow(have);
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
    this.#dropping = { sigs, dirs };
    for (const [k, f] of this.#files) {
      if (f.own !== "run") continue;
      // The next run may not report a file it did not find (a deleted tsconfig.json is looked for,
      // not read), so creating it again must still restart. A deleted import is reported again
      // by the failed resolve, while the app still imports it.
      if (f.gone && f.keepGone) continue;
      const presence = f.presence;
      f.own = undefined;
      f.presence = false;
      const [link] = f.links ?? [];
      if (link !== undefined) {
        f.shown = this.#files.get(link)?.path ?? f.shown;
        continue;
      }
      // An edit to a file only a glob wanted is no change, between runs either.
      this.#remove(k, !presence);
    }
    // The next run reports its globs again: their folders stay watched until then.
    for (const [k, w] of this.#walked) {
      const kept = w.walks.filter((walk) => !walk.owner.run);
      if (kept.length === w.walks.length) continue;
      dirs.add(w.dir);
      if (kept.length > 0) w.walks = kept;
      else this.#walked.delete(k);
    }
    this.#roots = this.#roots.filter((root) => !root.owner.run);
    this.#firedBefore = this.#fired;
    this.#fired = new Set();
    this.#dropping = undefined;
    this.#droppedSigs = sigs;
    // The folders dropped the time before may be unneeded now.
    if (this.#dropped.length > 0 && this.#o.poll === false) this.#scheduleSync();
    this.#dropped = [...dirs];
  }

  // `sig`: the file's stat, when the caller took it already.
  #put(file: string, shown: string, own: Entry["own"], presence = false, sig = sigOf(file)): Entry {
    const k = this.#key(file);
    const entry: Entry = { path: file, shown, sig, own, presence };
    this.#files.set(k, entry);
    // Dropped at the restart and changed since: the new run may have read it before the change.
    if (this.#droppedSigs.has(k)) {
      const before = this.#droppedSigs.get(k)!;
      this.#droppedSigs.delete(k);
      if (!presence && changed(before, entry.sig, false)) {
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
    const root: Root = { owner: this.#static, base, depth, missing: false };
    // Before the globs' roots, as its walks come first.
    const globs = this.#roots.findIndex((r) => r.owner.run);
    this.#roots.splice(globs < 0 ? this.#roots.length : globs, 0, root);
    // Now, before the app starts: what arrives from here on is a change, found when the watch opens.
    this.#walkRoot(root);
    if (this.#o.poll === false) this.#scheduleSync();
  }

  /**
   * Watch a glob the app reported, until `dropRun`. A file that appears in its roots and counts
   * is a change, and so is one of its files that disappears. An edit is not, unless the file is
   * wanted for itself too. `files` is what the app found: a listed file already gone, or a
   * counting file the first walk finds that is not listed, is a change at once.
   */
  addGlob(glob: GlobWatch): void {
    if (this.#closed) return;
    this.#o.debug(`glob ${glob.roots.map((r) => r.base).join(" ")}`);
    for (const file of glob.files ?? []) {
      if (!this.#lists(glob, file)) continue;
      const k = this.#key(file);
      const have = this.#files.get(k);
      if (have && have.own === undefined) {
        have.own = "run";
        have.presence = true;
      }
      const entry = have ?? this.#put(file, file, "run", true);
      if ((have ? sigOf(file) : entry.sig) === null) this.#fireOnce(k, entry.shown, false);
    }
    const owner: Owner = {
      run: true,
      prune: (dir) => glob.prune(dir),
      found: (file, fire, sig) => this.#globFound(glob, file, fire, sig),
    };
    for (const { base, depth } of glob.roots) {
      const root: Root = { owner, base, depth, missing: false };
      this.#roots.push(root);
      this.#walkRoot(root, glob.files !== undefined);
    }
    if (this.#o.poll === false) this.#scheduleSync();
  }

  // A listed file that the glob's walk would find: below one of its roots, within that root's
  // depth, in no folder the walk skips, and counting for the glob.
  #lists(glob: GlobWatch, file: string): boolean {
    const below = glob.roots.some(({ base, depth }) => {
      const rel = path.relative(base, file);
      if (rel === "" || path.isAbsolute(rel)) return false;
      const parts = rel.split(/[\\/]/);
      if (parts[0] === ".." || parts.length > depth) return false;
      let dir = base;
      for (const part of parts.slice(0, -1)) {
        dir = path.join(dir, part);
        if (glob.prune(dir)) return false;
      }
      return true;
    });
    return below && glob.counts(file);
  }

  // A file a glob's walk found.
  #globFound(glob: GlobWatch, file: string, fire: Fire, sig?: FileSig) {
    const k = this.#key(file);
    const have = this.#files.get(k);
    if (have) {
      // Wanted already, it keeps that behavior. Only a link's target so far: the glob's now too.
      if (have.own === undefined) {
        have.own = "run";
        have.presence = true;
      }
      return;
    }
    if (!sig || !glob.counts(file)) return;
    const next = sig();
    if (next === undefined) return;
    this.#put(file, file, "run", true, next);
    if (fire === "once") this.#fireOnce(k, file, true);
    else if (fire) this.#o.onChange(file);
  }

  // A change found when a glob is reported. The run before found it too: then the app cannot
  // see it (its list and the glob disagree), and another restart would find it again.
  #fireOnce(k: string, shown: string, exists: boolean) {
    // The state counts too: a file found new for one run and gone for the next changed twice.
    const key = `${exists ? "+" : "-"}${k}`;
    if (this.#firedBefore.has(key)) {
      this.#o.debug(`skip ${shown} (found for the run before)`);
      return;
    }
    this.#fired.add(key);
    queueMicrotask(() => this.#closed || this.#o.onChange(shown));
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#syncTimer);
    clearTimeout(this.#lingerTimer);
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

  // Files under a root that shows up later are new; at start they are not. `listed`: the first
  // walk of a glob that came with its files: what it finds is new since the app listed them.
  #walkRoot(root: Root, listed = false) {
    if (!isDir(root.base)) {
      root.missing = true;
      return false;
    }
    const fire: Fire = root.missing ? true : listed ? "once" : false;
    this.#walk(root.owner, root.base, 0, root.depth, fire);
    root.missing = false;
    return true;
  }

  #walk(owner: Owner, dir: string, level: number, depth: number, fire: Fire) {
    const k = this.#key(dir);
    const walked = this.#walked.get(k);
    const seen = walked?.walks.find((w) => w.owner === owner);
    // Roots can share folders (`src/*.ts` and `src/**/*.json`): the deeper walk wins.
    if (seen && seen.depth - seen.level >= depth - level) return;
    if (seen) Object.assign(seen, { level, depth });
    else if (!walked) this.#walked.set(k, { dir, walks: [{ owner, level, depth }] });
    // The `--include` walk first: a file it finds is not a glob's.
    else if (owner.run) walked.walks.push({ owner, level, depth });
    else walked.walks.unshift({ owner, level, depth });
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
        if (level + 1 < depth && !owner.prune(full))
          this.#walk(owner, full, level + 1, depth, fire);
      } else {
        // A file, or a link to one: its stat is taken when the owner wants the file.
        const sig = e.isFile() || e.isSymbolicLink() ? () => fileSigOf(full) : undefined;
        owner.found(full, fire, sig);
      }
    }
  }

  // A file an `--include` walk found.
  #found(file: string, fire: Fire, sig?: FileSig) {
    const have = this.#files.get(this.#key(file));
    if (have?.own === "static" || !sig) return;
    if (this.#o.matcher.classify(file, "walk") !== "watch") return;
    const next = sig();
    if (next === undefined) return;
    // Known from the imports or as a link's target: the walk keeps it now, and it is no change.
    if (have) {
      this.add(file);
      return;
    }
    if (this.#closed) return;
    this.#follow(this.#put(file, file, "static", false, next));
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
        // A hop can point at another file with the same stat too: see #check.
        hop.linkSig ??= linkSigOf(h);
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

  // `keepSig`: a change made before the next run reports the file again is a change.
  #remove(k: string, keepSig = true) {
    const entry = this.#files.get(k);
    if (!entry) return;
    this.#files.delete(k);
    if (this.#dropping) {
      if (keepSig) this.#dropping.sigs.set(k, entry.sig);
      this.#dropping.dirs.add(path.dirname(entry.path));
    }
    for (const h of entry.hops ?? []) this.#release(h, k);
    if (entry.target !== undefined) this.#release(entry.target, k);
    const dk = this.#key(path.dirname(entry.path));
    const set = this.#byDir.get(dk);
    set?.delete(k);
    if (set?.size === 0) this.#byDir.delete(dk);
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

    const now = Date.now();
    let lingers = Infinity;
    for (const [k, h] of this.#handles) {
      // A folder replaced by another (a rename over it) keeps the old watch on Linux and Windows.
      // On macOS the watch follows the path: one missing for now lingers, and an ancestor watch
      // sees the folder come back, renamed into place too, as it moves its watch.
      const state = this.#stateOf(h);
      if (state === "moved") {
        this.#drop(k, h);
        continue;
      }
      if (state === "gone") this.#gone(h);
      if (needed.has(k)) {
        h.idle = undefined;
        if (state === "replaced") this.#refresh(h);
      } else {
        // A run that fails early reports fewer files, and the next one reports them again: a
        // restart or a folder moved for a moment must not close and open its watches each time.
        h.idle ??= now;
        const left = h.idle + this.#linger - now;
        if (left <= 0) this.#drop(k, h);
        else lingers = Math.min(lingers, left);
      }
    }
    if (lingers !== Infinity) {
      clearTimeout(this.#lingerTimer);
      this.#lingerTimer = setTimeout(() => {
        this.#lingerTimer = undefined;
        this.#scheduleSync();
      }, lingers);
      this.#lingerTimer.unref?.();
    }
    const fresh: string[] = [];
    for (const [k, dir] of needed) {
      if (!this.#handles.has(k) && !this.#failed.has(k) && this.#open(k, dir)) fresh.push(dir);
    }
    // Files may have changed or arrived before the watch was open: after the stat or walk at
    // start, or while a folder was missing or replaced.
    for (const dir of fresh) {
      this.#checkDir(dir, false);
      this.#rescan(dir);
    }
  }

  /**
   * What became of a watch's folder: `moved` needs a new watch, `replaced` a new look at its
   * files. Linux and Windows watch the folder itself, so a new one is `moved` there. macOS watches
   * the path: a folder just found missing is `gone`, a new one there (or one back) is `replaced`,
   * and only a new real path is `moved`. The real path is looked up only when the folder is new,
   * so it costs a stat as before.
   */
  #stateOf(h: Handle): "moved" | "replaced" | "gone" | undefined {
    const id = idOf(h.dir);
    if (id === h.id) return undefined;
    if (!this.#mac) return "moved";
    if (id === undefined) return "gone";
    // Back after it was gone: maybe as a link to another folder, with the same identity.
    const real = realOf(h.dir);
    return real !== undefined && real !== h.real ? "moved" : "replaced";
  }

  // macOS: a folder replaced under its watch, by `rm -rf` and `mkdir` or a rename over it. The
  // watch reports the new folder's files from now on, but maybe not those already in it: a folder
  // renamed into place is named in an event for its parent only.
  #refresh(h: Handle) {
    h.id = idOf(h.dir);
    this.#o.debug(`replaced ${h.dir}`);
    this.#checkDir(h.dir, false);
    this.#rescan(h.dir);
  }

  // macOS: a folder found missing keeps its watch until it is back or `linger` has passed. Its
  // files are gone now, as the drop would see: FSEvents may name only the folder or an ancestor.
  #gone(h: Handle) {
    h.id = undefined;
    this.#o.debug(`gone ${h.dir}`);
    this.#checkDir(h.dir, false);
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

  // Look for new entries in a walked folder, for each owner that walked it.
  #rescan(dir: string) {
    const walked = this.#walked.get(this.#key(dir));
    if (!walked) return;
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
      const h: Handle = { w, dir, id, real: this.#mac ? realOf(dir) : undefined };
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
      this.#rescan(dir);
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
    const state = this.#stateOf(h);
    if (state === "moved") {
      this.#drop(dk, h);
      this.#scheduleSync();
    } else if (state === "replaced") {
      this.#refresh(h);
      this.#scheduleSync();
    } else if (state === "gone") {
      this.#gone(h);
      this.#scheduleSync();
    } else if (!existsSync(full)) {
      this.#scheduleSync();
    }
  }

  // One `lstat` for every owner that walked the folder.
  #onWalkedEntry(walked: WalkedDir, full: string) {
    let st: BigIntStats | undefined;
    try {
      st = lstatSync(full, { bigint: true });
    } catch {}
    // Not following links, as the first walk: a linked folder is not entered.
    if (st?.isDirectory()) {
      for (const w of walked.walks) {
        if (w.level + 1 < w.depth && !w.owner.prune(full)) {
          this.#walk(w.owner, full, w.level + 1, w.depth, true);
          this.#scheduleSync();
        }
      }
      return;
    }
    // A file's own stat is its `lstat`; a link's is its target's, taken once for every owner.
    let sig: FileSig | undefined;
    if (st?.isFile()) {
      const own = sigFrom(st);
      sig = () => own;
    } else if (st?.isSymbolicLink()) {
      sig = onceSig(() => fileSigOf(full));
    }
    for (const w of walked.walks) w.owner.found(full, true, sig);
  }

  #checkDir(dir: string, event = true) {
    for (const k of this.#byDir.get(this.#key(dir)) ?? []) this.#check(k, event);
  }

  #check(k: string, event = true) {
    const entry = this.#files.get(k)!;
    const next = sigOf(entry.path);
    if (entry.presence) {
      // Only a glob wants it: a file that appears or disappears is a change, an edit is not.
      const was = entry.sig !== null;
      entry.sig = next;
      if (was === (next !== null)) return;
      entry.gone = was;
      this.#o.onChange(entry.shown);
      return;
    }
    if (!changed(entry.sig, next, event)) {
      // A link stats as its target, so look at the link itself: it may point at another file
      // with the same stat (a hard link of it), or, its target deleted, be gone or pointed at
      // another missing file. Either way its old target must not stay.
      if (entry.linkSig !== undefined && changed(entry.linkSig, linkSigOf(entry.path), false)) {
        let moved = false;
        const follow = (link: Entry) => {
          const before = link.target;
          this.#follow(link);
          // Node.js loads it from the new path now, and resolves its imports from there.
          if (next !== null && link.target !== before) moved = true;
        };
        if (entry.target !== undefined) follow(entry);
        else entry.linkSig = linkSigOf(entry.path);
        // A hop: the links through it follow it again. A copy, as following changes the set.
        for (const l of Array.from(entry.links ?? [])) {
          const through = this.#files.get(l);
          if (through?.hops?.includes(k)) follow(through);
        }
        if (moved) this.#o.onChange(entry.shown);
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
    // A link in the middle of a chain: the links through it follow it again, also when it is
    // now a file. Not while it is gone, so that it coming back still restarts. A copy, as
    // following takes a link out of the set and puts it back.
    if (entry.links) {
      const link = isLink(entry.path);
      for (const l of Array.from(entry.links)) {
        const through = this.#files.get(l);
        if (through && (link || (next && through.hops?.includes(k)))) this.#follow(through);
      }
    }
    this.#o.onChange(entry.shown);
  }
}
