import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

/** Whether oxc-node sent this report: a tsconfig it read or a path a failed resolve tried. */
export function fromOxcNode(msg: unknown): boolean {
  return (
    typeof msg === "object" && msg !== null && (msg as Record<string, unknown>)["oxc-node"] === true
  );
}

/**
 * The paths in a `watch:require` / `watch:import` message, or null when it is not one.
 * Each entry is read on its own: Node.js drops the whole array when one entry is bad.
 */
export function parseWatchMessage(msg: unknown): string[] | null {
  if (typeof msg !== "object" || msg === null) return null;
  const record = msg as Record<string, unknown>;
  const lists = [record["watch:require"], record["watch:import"]];
  if (lists.every((list) => list === undefined)) return null;
  return lists.flatMap((list) => (Array.isArray(list) ? toPaths(list) : []));
}

/** The entries of `list` that are paths, as paths: a bad one is dropped alone. */
function toPaths(list: unknown[]): string[] {
  const paths: string[] = [];
  for (const entry of list) {
    try {
      const path = toPath(entry);
      if (path !== undefined) paths.push(path);
    } catch {}
  }
  return paths;
}

/** A `file:` URL or an absolute path, as a path; anything else, `undefined`. Throws for a bad URL. */
function toPath(entry: unknown): string | undefined {
  if (typeof entry !== "string" || entry === "") return undefined;
  // `resolve` drops the `/` a folder's URL ends with.
  if (entry.startsWith("file:")) return resolve(fileURLToPath(entry));
  // `node:fs`, `data:…`; a single letter is a Windows drive.
  if (/^[a-z][a-z\d+.-]+:/i.test(entry)) return undefined;
  if (!isAbsolute(entry)) return undefined;
  return resolve(entry);
}

/**
 * One entry of a `watch:glob` report: the files a glob in the app stands for. The watcher walks
 * `roots` for files that appear, and the embedder's `globMatcher` reads the rest.
 */
export interface WatchGlob {
  /** Folders to walk. `depth` counts levels below `base` (1: the files in it); absent, no limit. */
  roots: { base: string; depth?: number }[];
  /** Absolute patterns with `/`. */
  include: string[];
  exclude?: string[];
  /** Match files whose name starts with `.`, and walk such folders. */
  dot?: boolean;
  nocase?: boolean;
  /** The files that existed when the app listed them. */
  files?: string[];
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((s) => typeof s === "string");

const isDepth = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);

/**
 * The entries of a `watch:glob` message, or null when it is not one. Each entry is read on its
 * own, and a bad one is dropped. A bad path in `files` is dropped alone.
 */
export function parseWatchGlobs(msg: unknown): WatchGlob[] | null {
  if (typeof msg !== "object" || msg === null) return null;
  const list = (msg as Record<string, unknown>)["watch:glob"];
  if (list === undefined) return null;
  const globs: WatchGlob[] = [];
  if (!Array.isArray(list)) return globs;
  for (const entry of list) {
    try {
      const glob = parseGlob(entry);
      if (glob) globs.push(glob);
    } catch {}
  }
  return globs;
}

function parseGlob(entry: unknown): WatchGlob | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { roots, include, exclude, dot, nocase, files } = entry as Record<string, unknown>;
  if (!Array.isArray(roots) || roots.length === 0) return undefined;
  if (!isStrings(include) || include.length === 0) return undefined;
  if (exclude !== undefined && !isStrings(exclude)) return undefined;
  if (files !== undefined && !isStrings(files)) return undefined;
  if (dot !== undefined && typeof dot !== "boolean") return undefined;
  if (nocase !== undefined && typeof nocase !== "boolean") return undefined;
  const glob: WatchGlob = { roots: [], include };
  for (const root of roots) {
    if (typeof root !== "object" || root === null) return undefined;
    const { base, depth } = root as Record<string, unknown>;
    const path = toPath(base);
    if (path === undefined || !isDepth(depth)) return undefined;
    glob.roots.push(depth === undefined ? { base: path } : { base: path, depth: depth as number });
  }
  if (exclude !== undefined) glob.exclude = exclude;
  if (dot !== undefined) glob.dot = dot;
  if (nocase !== undefined) glob.nocase = nocase;
  if (files !== undefined) glob.files = toPaths(files);
  return glob;
}
