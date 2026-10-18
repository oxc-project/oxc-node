import { statSync } from "node:fs";
import path from "node:path";

export type Source = "graph" | "walk" | "literal";
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
  const absolute = (pattern: string) => {
    const p = norm(pattern);
    return native.isAbsolute(pattern) ? p : path.posix.join(cwd, p);
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
    if (native.isAbsolute(pattern)) {
      const g = norm(pattern);
      return (n: string) => matchesGlob!(n, g);
    }
    const g = path.posix.normalize(norm(pattern));
    return (n: string) => matchesGlob!(path.posix.relative(cwd, n), g);
  };

  const excludes = opts.exclude.map((p) => (GLOB_CHARS.test(p) ? glob(p) : literal(absolute(p))));
  const includes: ((n: string) => boolean)[] = [];
  // The parts of each include glob below its base, to tell when one names a folder that walks
  // skip by default: `packages/**/node_modules/pkg/**`, `**/.storybook/*.ts`.
  const named: string[] = [];
  const roots: { base: string; depth: number }[] = [];
  const literals: string[] = [];
  for (const pattern of opts.include) {
    if (!GLOB_CHARS.test(pattern)) {
      const abs = native.resolve(opts.cwd, pattern);
      if (isDir(abs)) {
        includes.push(literal(norm(abs)));
        roots.push({ base: abs, depth: Infinity });
      } else {
        includes.push((n) => n === norm(abs));
        literals.push(abs);
      }
      continue;
    }
    includes.push(glob(pattern));
    const parts = pattern.split(win ? /[\\/]/ : "/");
    let baseLen = 0;
    while (baseLen < parts.length - 1 && !GLOB_CHARS.test(parts[baseLen])) baseLen++;
    const rest = parts.slice(baseLen);
    named.push(...rest.map(norm));
    roots.push({
      base: native.resolve(opts.cwd, parts.slice(0, baseLen).join("/") || "."),
      depth: rest.includes("**") ? Infinity : rest.length,
    });
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
      if (n.split("/").includes("node_modules") || ignoreDirs.some((d) => literal(d)(n))) {
        return "default-ignore";
      }
      return "watch";
    },
    roots: () => roots,
    literals: () => literals,
    pruneDir(absDir) {
      const n = norm(absDir);
      const name = path.posix.basename(n);
      // A part names such a folder when it matches it but not just any name: `.storybook`,
      // `{node_modules,src}`, `@(node_modules|src)` do; `*` never walks into every node_modules.
      const skipped =
        (name === "node_modules" || name.startsWith(".")) &&
        !named.some((part) =>
          GLOB_CHARS.test(part)
            ? matchesGlob!(name, part) && !matchesGlob!("oxnode-any-name", part)
            : part === name,
        );
      // `**/dist/**` matches what is inside dist, not dist itself.
      return skipped || excluded(n) || excluded(`${n}/__probe__`);
    },
  };
}
