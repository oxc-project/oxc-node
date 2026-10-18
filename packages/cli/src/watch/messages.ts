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
  const paths: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      try {
        if (typeof entry !== "string" || entry === "") continue;
        if (entry.startsWith("file:")) {
          paths.push(fileURLToPath(entry));
          continue;
        }
        // `node:fs`, `data:…`; a single letter is a Windows drive.
        if (/^[a-z][a-z\d+.-]+:/i.test(entry)) continue;
        if (!isAbsolute(entry)) continue;
        paths.push(resolve(entry));
      } catch {}
    }
  }
  return paths;
}
