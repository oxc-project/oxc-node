import { statSync } from "node:fs";
import path from "node:path";

// "oxc": reported by oxc-node (a tsconfig, a missing file), not by Node.js. Like "graph",
// it counts for one run.
export type Source = "graph" | "oxc" | "walk" | "literal";
export type Verdict = "watch" | "exclude" | "default-ignore";

export interface Matcher {
  /** exclude > include match > default ignores > graph. Walked files must match an include. */
  classify(absPath: string, source: Source): Verdict;
  /** Folders to walk for `--include` globs and literal folders. `depth` counts path parts below `base`. */
  roots(): { base: string; depth: number }[];
  /** `--include` patterns naming one file, which may not exist yet. */
  literals(): string[];
  /** Whether a walk skips a folder below one of its roots. */
  pruneDir(absDir: string): boolean;
}

// `@ + !` mean something only before `(`: scoped packages and `(group)` folders are literal.
const GLOB_CHARS = /[*?[\]{}]|[+@!]\(/;

const MAX_EXPANSIONS = 64;

/**
 * `a/{b,c/d}/e` → `a/b/e`, `a/c/d/e`. Groups without a comma (`{1..3}`) stay. Too many
 * alternatives: the pattern as it is. `\\` escapes, except on Windows, where it is a separator.
 */
export function expandBraces(pattern: string, win: boolean): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && !win) {
      i++;
    } else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      const alts = splitTop(pattern.slice(start + 1, i), win);
      if (alts.length < 2) continue;
      const [pre, post] = [pattern.slice(0, start), pattern.slice(i + 1)];
      const out: string[] = [];
      for (const alt of alts) {
        for (const one of expandBraces(pre + alt + post, win)) {
          out.push(one);
          if (out.length > MAX_EXPANSIONS) return [pattern];
        }
      }
      return out;
    }
  }
  return [pattern];
}

// Split a group's body at its own commas, not those of groups inside it.
function splitTop(body: string, win: boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && !win) i++;
    else if (c === "{") depth++;
    else if (c === "}" && depth > 0) depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(from, i));
      from = i + 1;
    }
  }
  out.push(body.slice(from));
  return out;
}

export const isDirOnDisk = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function makeMatcher(opts: {
  cwd: string;
  include: string[];
  exclude: string[];
  platform: NodeJS.Platform;
  /** Folders whose files are never graph files (oxc-node itself). */
  ignoreDirs?: string[];
  isDir?: (absPath: string) => boolean;
}): Matcher {
  const win = opts.platform === "win32";
  const native = win ? path.win32 : path.posix;
  const isDir = opts.isDir ?? isDirOnDisk;
  // Globs use `/`. Only Windows turns `\` into `/`: elsewhere it is a glob escape.
  // Windows paths are case-insensitive, and `matchesGlob` is not.
  const norm = (p: string) => (win ? p.replaceAll("\\", "/").toLowerCase() : p);
  const cwd = norm(opts.cwd);
  // On Windows `/x` is on cwd's drive: `C:/x`.
  const drive = win ? native.resolve(opts.cwd, "/").replace(/[\\/]$/, "") : "";
  // `C:src` is relative to the current folder on C:.
  const rooted = (pattern: string) =>
    !win
      ? pattern
      : /^[\\/](?![\\/])/.test(pattern)
        ? drive + pattern
        : /^[A-Za-z]:(?![\\/])/.test(pattern)
          ? native.resolve(opts.cwd, pattern)
          : pattern;
  const absolute = (pattern: string) => {
    const p = norm(rooted(pattern));
    return native.isAbsolute(rooted(pattern)) ? p : path.posix.join(cwd, p);
  };

  const globs = [...opts.include, ...opts.exclude].filter((p) => GLOB_CHARS.test(p));
  const matchesGlob = path.posix.matchesGlob as ((p: string, g: string) => boolean) | undefined;
  if (globs.length && typeof matchesGlob !== "function") {
    throw new Error(`--include and --exclude globs need Node.js 22.5 or later (path.matchesGlob)`);
  }

  // A literal matches itself and everything below it.
  const literal = (lit: string) => (n: string) => n === lit || n.startsWith(`${lit}/`);
  // A relative glob is matched against the path relative to cwd, so `[ ] { }` in cwd stay literal.
  const glob = (pattern: string) => {
    if (native.isAbsolute(rooted(pattern))) {
      const g = norm(rooted(pattern));
      return (n: string) => matchesGlob!(n, g);
    }
    const g = path.posix.normalize(norm(pattern));
    return (n: string) => matchesGlob!(path.posix.relative(cwd, n), g);
  };

  const excludes = opts.exclude.map((p) => (GLOB_CHARS.test(p) ? glob(p) : literal(absolute(p))));
  const treeExcludes = opts.exclude.filter((p) => /[\\/]\*\*$/.test(p)).map(glob);
  const includes: ((n: string) => boolean)[] = [];
  // The parts of each include glob below its base, to tell when one names a folder that walks
  // skip by default: `packages/**/node_modules/pkg/**`, `**/.storybook/*.ts`. Each holds only
  // below its own base, so `src/**/*.ts` next to it still skips `src/node_modules`.
  const named: { base: string; parts: string[] }[] = [];
  const roots: { base: string; depth: number }[] = [];
  const literals: string[] = [];
  for (const pattern of opts.include) {
    if (!GLOB_CHARS.test(pattern)) {
      const abs = native.resolve(opts.cwd, pattern);
      if (isDir(abs)) {
        includes.push(literal(norm(abs)));
        roots.push({ base: abs, depth: Infinity });
      } else {
        // A file, or nothing yet: it may also come (back) as a folder, walked once it does.
        includes.push(literal(norm(abs)));
        literals.push(abs);
        roots.push({ base: abs, depth: Infinity });
      }
      continue;
    }
    includes.push(glob(pattern));
    // `{src/**,node_modules/**}/*.ts`: a group can hold `/`, so expand groups before splitting.
    for (const one of expandBraces(pattern, win)) {
      const parts = one.split(win ? /[\\/]/ : "/");
      let baseLen = 0;
      while (baseLen < parts.length - 1 && !GLOB_CHARS.test(parts[baseLen])) baseLen++;
      const rest = parts.slice(baseLen);
      // `/*.json` and `C:/*.json` start at the root, not at cwd.
      const fixed = baseLen === 0 ? "." : parts.slice(0, baseLen).join("/") || "/";
      const base = native.resolve(opts.cwd, /^[A-Za-z]:$/.test(fixed) ? `${fixed}/` : fixed);
      named.push({ base: norm(base), parts: rest.map(norm) });
      roots.push({ base, depth: rest.includes("**") ? Infinity : rest.length });
    }
  }

  const ignoreDirs = (opts.ignoreDirs ?? []).map(norm);
  const excluded = (n: string) => excludes.some((m) => m(n));

  return {
    classify(absPath, source) {
      const n = norm(absPath);
      if (excluded(n)) return "exclude";
      if (includes.some((m) => m(n))) return "watch";
      if (source === "literal") return "watch";
      if (source === "walk") return "default-ignore";
      // A tsconfig can `extends` one from a package.
      const inNodeModules = source !== "oxc" && n.split("/").includes("node_modules");
      if (inNodeModules || ignoreDirs.some((d) => literal(d)(n))) {
        return "default-ignore";
      }
      return "watch";
    },
    roots: () => roots,
    literals: () => literals,
    pruneDir(absDir) {
      const n = norm(absDir);
      const name = path.posix.basename(n);
      // Whether the folders from the base down to this one fit the include's parts in order, with
      // this one named by a part. A part names it when it matches it but not just any name:
      // `.storybook`, `{node_modules,src}`, `@(node_modules|src)` do; `*` and `**` never walk
      // into every node_modules.
      const fits = (dirs: string[], parts: string[], i = 0, j = 0): boolean => {
        if (i === dirs.length) return true;
        const part = parts[j];
        // The last part is for files, unless it is `**`.
        if (part === undefined || (j === parts.length - 1 && part !== "**")) return false;
        const last = i === dirs.length - 1;
        if (part === "**") {
          return fits(dirs, parts, i, j + 1) || (!last && fits(dirs, parts, i + 1, j));
        }
        const ok = GLOB_CHARS.test(part)
          ? matchesGlob!(dirs[i], part) && !(last && matchesGlob!("oxnode-any-name", part))
          : part === dirs[i];
        return ok && fits(dirs, parts, i + 1, j + 1);
      };
      const skipped =
        (name === "node_modules" || name.startsWith(".")) &&
        !named.some(
          (include) =>
            // A folder in the fixed part (`node_modules/pkg/**`) is named by it.
            n === include.base ||
            (n.startsWith(include.base.endsWith("/") ? include.base : `${include.base}/`) &&
              fits(n.slice(include.base.replace(/\/$/, "").length + 1).split("/"), include.parts)),
        );
      // `**/dist/**` matches what is inside dist, not dist itself. Only such a `/**` exclude
      // speaks for every child: `dir/!(keep)` leaves `dir/keep`.
      return skipped || excluded(n) || treeExcludes.some((m) => m(`${n}/__probe__`));
    },
  };
}
