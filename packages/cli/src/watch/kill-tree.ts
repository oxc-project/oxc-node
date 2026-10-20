import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcRow {
  pid: number;
  ppid: number;
}

/** One `/proc/<pid>/stat` line. The name in parentheses may hold spaces and `)`. */
export function parseProcStat(text: string): ProcRow | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const pid = Number.parseInt(text, 10);
  // After the name: state, ppid, …
  const ppid = Number(
    text
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  );
  return Number.isInteger(pid) && Number.isInteger(ppid) ? { pid, ppid } : null;
}

/** The output of `ps -A -o pid=,ppid=`. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return rows;
}

/** Every process below `pid`, parents before their children. */
export function descendants(table: ProcRow[], pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const out: number[] = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Every process on the machine: `/proc` on Linux, where `ps` may be missing (slim containers), `ps` elsewhere. */
export function processTable(): ProcRow[] {
  try {
    if (process.platform === "linux") {
      const rows: ProcRow[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const row = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
          if (row) rows.push(row);
        } catch {}
      }
      return rows;
    }
    return parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }));
  } catch {
    return [];
  }
}

/** SIGKILL the child and everything it started, so a grandchild cannot keep a port busy. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.on("error", () => child.kill());
    return;
  }
  // One snapshot before the first kill: orphans are re-parented and would be lost.
  for (const p of [pid, ...descendants(processTable(), pid)]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
}
