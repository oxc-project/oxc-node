import { describe, expect, test } from "vitest";

import { expandBraces, makeMatcher } from "../../cli/src/watch/glob.js";

const CWD = "/proj";
const dirs = new Set(["/proj/config", "/proj/src"]);

const matcher = (
  include: string[],
  exclude: string[] = [],
  extra: { ignoreDirs?: string[] } = {},
) =>
  makeMatcher({
    cwd: CWD,
    include,
    exclude,
    platform: "linux",
    isDir: (p) => dirs.has(p),
    ...extra,
  });

describe("makeMatcher", () => {
  test("* stays in one folder, ** crosses folders", () => {
    const m = matcher(["src/*.json", "data/**/*.csv"]);
    expect(m.classify("/proj/src/a.json", "walk")).toBe("watch");
    expect(m.classify("/proj/src/deep/a.json", "walk")).toBe("default-ignore");
    expect(m.classify("/proj/data/a.csv", "walk")).toBe("watch");
    expect(m.classify("/proj/data/x/y/a.csv", "walk")).toBe("watch");
  });

  test("dot folders are skipped by walks only", () => {
    const m = matcher(["**/*.ts"]);
    expect(m.pruneDir("/proj/.git")).toBe(true);
    expect(m.pruneDir("/proj/src/.cache")).toBe(true);
    // A file the app really loads from a dot folder is watched.
    expect(m.classify("/proj/.storybook/main.ts", "graph")).toBe("watch");
    // A project inside a dot folder still works: only folders below a root are checked.
    const inDot = makeMatcher({
      cwd: "/home/u/.config/app",
      include: ["src/**"],
      exclude: [],
      platform: "linux",
    });
    expect(inDot.roots()).toEqual([{ base: "/home/u/.config/app/src", depth: Infinity }]);
    expect(inDot.classify("/home/u/.config/app/src/a.ts", "walk")).toBe("watch");
    expect(inDot.classify("/home/u/.config/app/src/a.ts", "graph")).toBe("watch");
  });

  test("node_modules anywhere is ignored for graph files and walks", () => {
    const m = matcher([]);
    expect(m.classify("/proj/node_modules/pkg/index.js", "graph")).toBe("default-ignore");
    expect(m.classify("/proj/packages/a/node_modules/pkg/index.js", "graph")).toBe(
      "default-ignore",
    );
    expect(m.classify("/proj/src/index.ts", "graph")).toBe("watch");
    expect(m.pruneDir("/proj/src/node_modules")).toBe(true);
  });

  test("--include naming node_modules opts in", () => {
    const m = matcher(["node_modules/pkg/**"]);
    expect(m.classify("/proj/node_modules/pkg/index.js", "graph")).toBe("watch");
    expect(m.classify("/proj/node_modules/other/index.js", "graph")).toBe("default-ignore");
    expect(m.roots()).toEqual([{ base: "/proj/node_modules/pkg", depth: Infinity }]);
  });

  test("oxc-node's own folder is ignored", () => {
    const m = matcher([], [], { ignoreDirs: ["/repo/packages/core"] });
    expect(m.classify("/repo/packages/core/register.mjs", "graph")).toBe("default-ignore");
    expect(m.classify("/repo/packages/core-app/a.ts", "graph")).toBe("watch");
  });

  test("a literal folder is folder/**, a literal file is a literal", () => {
    const m = matcher(["config", ".env", "later/new.json"]);
    // Not a folder (yet): also walked if one shows up there.
    expect(m.roots()).toEqual([
      { base: "/proj/config", depth: Infinity },
      { base: "/proj/.env", depth: Infinity },
      { base: "/proj/later/new.json", depth: Infinity },
    ]);
    expect(m.literals()).toEqual(["/proj/.env", "/proj/later/new.json"]);
    expect(m.classify("/proj/config/a/b.yaml", "walk")).toBe("watch");
    expect(m.classify("/proj/.env", "literal")).toBe("watch");
    expect(m.classify("/proj/.env.local", "walk")).toBe("default-ignore");
    expect(m.classify("/proj/later/new.json/a.json", "walk")).toBe("watch");
  });

  test("base and depth", () => {
    const roots = matcher([
      "src/*.json",
      "src/*/x.ts",
      "a/b/**/c.ts",
      "{x,y}/z.ts",
      "/abs/dir/*.txt",
      "./rel/**",
    ]).roots();
    expect(roots).toEqual([
      { base: "/proj/src", depth: 1 },
      { base: "/proj/src", depth: 2 },
      { base: "/proj/a/b", depth: Infinity },
      // Each alternative of a group, from its own fixed part.
      { base: "/proj/x", depth: 1 },
      { base: "/proj/y", depth: 1 },
      { base: "/abs/dir", depth: 1 },
      { base: "/proj/rel", depth: Infinity },
    ]);
  });

  test("exclude beats include, which beats the default ignores", () => {
    const m = matcher(
      ["node_modules/pkg/**", "src/**"],
      ["src/**/*.test.ts", "node_modules/pkg/dist/**"],
    );
    expect(m.classify("/proj/src/a.test.ts", "walk")).toBe("exclude");
    expect(m.classify("/proj/src/a.test.ts", "graph")).toBe("exclude");
    expect(m.classify("/proj/src/a.ts", "walk")).toBe("watch");
    expect(m.classify("/proj/node_modules/pkg/dist/x.js", "graph")).toBe("exclude");
    expect(m.classify("/proj/node_modules/pkg/src/x.js", "graph")).toBe("watch");
  });

  test("exclude wins over literals, even the entry", () => {
    const m = matcher([], ["app.ts", "generated"]);
    expect(m.classify("/proj/app.ts", "literal")).toBe("exclude");
    expect(m.classify("/proj/generated/a.ts", "graph")).toBe("exclude");
    expect(m.classify("/proj/generated-not/a.ts", "graph")).toBe("watch");
  });

  test("pruneDir keeps a node_modules or dot folder that an include names below its base", () => {
    const pkg = matcher(["packages/**/node_modules/pkg/**"]);
    expect(pkg.pruneDir("/proj/packages/a/node_modules")).toBe(false);
    expect(pkg.classify("/proj/packages/a/node_modules/pkg/index.js", "walk")).toBe("watch");
    expect(pkg.pruneDir("/proj/packages/a/.cache")).toBe(true);
    const story = matcher(["**/.storybook/*.ts"]);
    expect(story.pruneDir("/proj/app/.storybook")).toBe(false);
    expect(story.pruneDir("/proj/app/.git")).toBe(true);
    expect(story.pruneDir("/proj/node_modules")).toBe(true);
    expect(matcher(["**/.*/*.ts"]).pruneDir("/proj/.config")).toBe(false);
    // Grouped names count; a bare `*` or a negation does not name node_modules.
    expect(matcher(["{node_modules,src}/**/*.js"]).pruneDir("/proj/node_modules")).toBe(false);
    expect(matcher(["@(node_modules|src)/**/*.js"]).pruneDir("/proj/node_modules")).toBe(false);
    expect(matcher(["**/{.storybook,stories}/*.ts"]).pruneDir("/proj/a/.storybook")).toBe(false);
    expect(matcher(["*/*/*.ts"]).pruneDir("/proj/node_modules")).toBe(true);
    expect(matcher(["!(dist)/**/*.ts"]).pruneDir("/proj/node_modules")).toBe(true);
    // The opt-in holds only below the base of the pattern that names the folder.
    const two = matcher(["vendor/**/node_modules/pkg/**", "src/**/*.ts"]);
    expect(two.pruneDir("/proj/vendor/a/node_modules")).toBe(false);
    expect(two.pruneDir("/proj/src/node_modules")).toBe(true);
    // Only where the folder can be on the pattern's path, not wherever its name appears.
    const deep = matcher(["src/{web,api}/fixtures/node_modules/pkg/**"]);
    // Each alternative is walked from its own fixed part.
    expect(deep.roots()).toEqual([
      { base: "/proj/src/web/fixtures/node_modules/pkg", depth: Infinity },
      { base: "/proj/src/api/fixtures/node_modules/pkg", depth: Infinity },
    ]);
    expect(deep.pruneDir("/proj/src/node_modules")).toBe(true);
    expect(deep.pruneDir("/proj/src/web/node_modules")).toBe(true);
    expect(deep.pruneDir("/proj/src/web/fixtures/node_modules/pkg/node_modules")).toBe(true);
    // A group may hold `/`.
    const slash = matcher(["{src/**,node_modules/**}/*.ts"]);
    expect(slash.roots()).toEqual([
      { base: "/proj/src", depth: Infinity },
      { base: "/proj/node_modules", depth: Infinity },
    ]);
    expect(slash.pruneDir("/proj/node_modules")).toBe(false);
    expect(slash.pruneDir("/proj/node_modules/pkg/node_modules")).toBe(true);
    expect(slash.classify("/proj/node_modules/pkg/a.ts", "walk")).toBe("watch");
    expect(
      matcher(["src/*.ts", "src/x/node_modules/*.js"]).pruneDir("/proj/src/node_modules"),
    ).toBe(true);
  });

  test("pruneDir keeps a folder when an exclude spares some of its children", () => {
    const m = matcher(["**/*.ts"], ["dir/!(keep)"]);
    expect(m.pruneDir("/proj/dir")).toBe(false);
    expect(m.pruneDir("/proj/dir/keep")).toBe(false);
    expect(m.pruneDir("/proj/dir/other")).toBe(true);
    expect(matcher(["**/*.ts"], ["dir/*"]).pruneDir("/proj/dir")).toBe(false);
    expect(matcher(["**/*.ts"], ["dir/**"]).pruneDir("/proj/dir")).toBe(true);
  });

  test("expandBraces", () => {
    expect(expandBraces("a/{b,c/d}/e", false)).toEqual(["a/b/e", "a/c/d/e"]);
    expect(expandBraces("{a,{b,c}}x", false)).toEqual(["ax", "bx", "cx"]);
    expect(expandBraces("{a,b}{c,d}", false)).toEqual(["ac", "ad", "bc", "bd"]);
    expect(expandBraces("x{1..3}/{a,b}", false)).toEqual(["x{1..3}/a", "x{1..3}/b"]);
    expect(expandBraces("\\{a,b}", false)).toEqual(["\\{a,b}"]);
    expect(expandBraces("src\\{a,b}", true)).toEqual(["src\\a", "src\\b"]);
    const many = "{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}";
    expect(expandBraces(many, false)).toEqual([many]);
  });

  test("pruneDir with **/dist/**", () => {
    const m = matcher(["**/*.js"], ["**/dist/**"]);
    expect(m.pruneDir("/proj/dist")).toBe(true);
    expect(m.pruneDir("/proj/packages/a/dist")).toBe(true);
    expect(m.pruneDir("/proj/distant")).toBe(false);
    expect(m.pruneDir("/proj/src")).toBe(false);
  });

  test("glob characters in cwd are not glob syntax", () => {
    for (const cwd of ["/x/proj [2024]", "/x/a{b,c}", "/x/p@(1)"]) {
      const m = makeMatcher({
        cwd,
        include: ["config/*.json", "./src/**"],
        exclude: ["**/*.test.ts", "../shared/*.ts"],
        platform: "linux",
        isDir: () => false,
      });
      expect(m.classify(`${cwd}/config/a.json`, "walk"), cwd).toBe("watch");
      expect(m.classify(`${cwd}/src/a.ts`, "walk"), cwd).toBe("watch");
      expect(m.classify(`${cwd}/src/a.test.ts`, "graph"), cwd).toBe("exclude");
      expect(m.classify("/x/shared/a.ts", "graph"), cwd).toBe("exclude");
      // `**` does not reach out of cwd.
      expect(m.classify("/elsewhere/a.test.ts", "graph"), cwd).toBe("watch");
      expect(m.roots()[0], cwd).toEqual({ base: `${cwd}/config`, depth: 1 });
    }
  });

  test("an absolute glob with a glob first starts at the root", () => {
    const m = matcher(["/*.json", "/**/.storybook/*.ts"]);
    expect(m.roots()).toEqual([
      { base: "/", depth: 1 },
      { base: "/", depth: Infinity },
    ]);
    expect(m.classify("/a.json", "walk")).toBe("watch");
    expect(m.pruneDir("/app/.storybook")).toBe(false);
    expect(m.pruneDir("/app/.git")).toBe(true);
    const win = makeMatcher({
      cwd: "C:\\proj",
      include: ["D:/*.json"],
      exclude: [],
      platform: "win32",
      isDir: () => false,
    });
    expect(win.roots()).toEqual([{ base: "D:\\", depth: 1 }]);
    // No drive: cwd's drive.
    const noDrive = makeMatcher({
      cwd: "C:\\proj",
      include: ["/*.json", "\\etc\\app.conf"],
      exclude: ["/skip.json"],
      platform: "win32",
      isDir: () => false,
    });
    expect(noDrive.roots()[0]).toEqual({ base: "C:\\", depth: 1 });
    expect(noDrive.classify("C:\\a.json", "walk")).toBe("watch");
    expect(noDrive.classify("C:\\skip.json", "walk")).toBe("exclude");
    expect(noDrive.classify("C:\\etc\\app.conf", "walk")).toBe("watch");
    expect(noDrive.literals()).toEqual(["C:\\etc\\app.conf"]);
    // Drive-relative: from cwd when cwd is on that drive.
    const driveRel = makeMatcher({
      cwd: "C:\\proj",
      include: ["C:src/*.ts"],
      exclude: [],
      platform: "win32",
      isDir: () => false,
    });
    expect(driveRel.roots()).toEqual([{ base: "C:\\proj\\src", depth: 1 }]);
    expect(driveRel.classify("C:\\proj\\src\\a.ts", "walk")).toBe("watch");
  });

  test("@ + ! ( ) are glob syntax only as an extglob", () => {
    const scoped = new Set(["/proj/node_modules/@org/lib", "/proj/src/routes/(app)"]);
    const m = makeMatcher({
      cwd: CWD,
      include: ["node_modules/@org/lib", "node_modules/@scope/pkg/**", "src/routes/(app)"],
      exclude: ["src/@gen", "src/!(keep).js", "@(a|b)/**"],
      platform: "linux",
      isDir: (p) => scoped.has(p),
    });
    expect(m.roots()).toEqual([
      { base: "/proj/node_modules/@org/lib", depth: Infinity },
      { base: "/proj/node_modules/@scope/pkg", depth: Infinity },
      { base: "/proj/src/routes/(app)", depth: Infinity },
    ]);
    expect(m.classify("/proj/node_modules/@org/lib/index.js", "walk")).toBe("watch");
    expect(m.classify("/proj/node_modules/@org/lib/index.js", "graph")).toBe("watch");
    expect(m.classify("/proj/node_modules/@scope/pkg/a/b.js", "walk")).toBe("watch");
    expect(m.classify("/proj/src/routes/(app)/page.ts", "walk")).toBe("watch");
    expect(m.classify("/proj/src/@gen/x.ts", "graph")).toBe("exclude");
    // Extglobs still work.
    expect(m.classify("/proj/src/other.js", "graph")).toBe("exclude");
    expect(m.classify("/proj/src/keep.js", "graph")).toBe("watch");
    expect(m.classify("/proj/a/x.ts", "graph")).toBe("exclude");
    expect(m.classify("/proj/c/x.ts", "graph")).toBe("watch");
  });

  test("win32: \\ and case", () => {
    const m = makeMatcher({
      cwd: "C:\\Proj",
      include: ["Config\\*.JSON"],
      exclude: ["src/**/*.Test.ts"],
      platform: "win32",
      isDir: () => false,
    });
    expect(m.classify("c:\\proj\\config\\a.json", "walk")).toBe("watch");
    expect(m.classify("C:\\PROJ\\SRC\\deep\\A.TEST.TS", "graph")).toBe("exclude");
    expect(m.classify("C:\\Proj\\node_modules\\x\\i.js", "graph")).toBe("default-ignore");
    expect(m.roots()).toEqual([{ base: "C:\\Proj\\Config", depth: 1 }]);
  });
});
