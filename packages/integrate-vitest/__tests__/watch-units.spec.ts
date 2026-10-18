import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { descendants, parseProcStat, parsePs } from "../../cli/src/watch/kill-tree.js";
import { parseWatchMessage } from "../../cli/src/watch/messages.js";

const abs = (p: string) => resolve(p);

describe("parseWatchMessage", () => {
  test("not a watch message", () => {
    expect(parseWatchMessage(null)).toBe(null);
    expect(parseWatchMessage("watch:import")).toBe(null);
    expect(parseWatchMessage({ type: "ready" })).toBe(null);
    expect(parseWatchMessage(42)).toBe(null);
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
