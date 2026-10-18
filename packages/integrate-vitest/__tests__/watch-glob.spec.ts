import { describe, expect, test } from "vitest";

import { makeMatcher } from "../../cli/src/watch/glob.js";

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
    expect(m.roots()).toEqual([{ base: "/proj/config", depth: Infinity }]);
    expect(m.literals()).toEqual(["/proj/.env", "/proj/later/new.json"]);
    expect(m.classify("/proj/config/a/b.yaml", "walk")).toBe("watch");
    expect(m.classify("/proj/.env", "literal")).toBe("watch");
    expect(m.classify("/proj/.env.local", "walk")).toBe("default-ignore");
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
      { base: "/proj", depth: 2 },
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

  test("pruneDir with **/dist/**", () => {
    const m = matcher(["**/*.js"], ["**/dist/**"]);
    expect(m.pruneDir("/proj/dist")).toBe(true);
    expect(m.pruneDir("/proj/packages/a/dist")).toBe(true);
    expect(m.pruneDir("/proj/distant")).toBe(false);
    expect(m.pruneDir("/proj/src")).toBe(false);
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
