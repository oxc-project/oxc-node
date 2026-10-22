import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Exited, not reaped. It holds no port, so it counts as gone: as PID 1, oxnode never reaps the orphans it adopts. */
  zombie?: boolean;
  /** When it started, as an opaque token: the same PID with another start is another process. */
  start?: string;
}

/** One `/proc/<pid>/stat` line. The name in parentheses may hold spaces and `)`. */
export function parseProcStat(text: string): ProcRow | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const pid = Number.parseInt(text, 10);
  // After the name: state, ppid, …, starttime (field 22, the 20th here).
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, zombie: /^[ZXx]/.test(fields[0]) || undefined, start: fields[19] };
}

/** The output of `ps -A -o pid=,ppid=,stat=,lstart=`, or of `ps -A -o pid=,ppid=`. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    // `lstart` comes last: it holds spaces, and is kept as it is.
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(\S+)(?:\s+(\S.*?))?)?\s*$/.exec(line);
    if (m) {
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        zombie: m[3]?.startsWith("Z") || undefined,
        start: m[4],
      });
    }
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

/** The rows of every process below `pid`, parents first. */
export function subtree(table: ProcRow[], pid: number): ProcRow[] {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  return descendants(table, pid).map((p) => byPid.get(p)!);
}

/** Every process on the machine: `/proc` on Linux, where `ps` may be missing (slim containers), `ps` elsewhere. */
export function processTable(): ProcRow[] {
  if (process.platform === "linux") {
    try {
      const rows: ProcRow[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const row = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
          if (row) rows.push(row);
        } catch {}
      }
      return rows;
    } catch {
      return [];
    }
  }
  // Some `ps` have no `lstart`: fall back to the two columns, without the PID reuse check.
  for (const columns of ["pid=,ppid=,stat=,lstart=", "pid=,ppid="]) {
    try {
      return parsePs(
        execFileSync("ps", ["-A", "-o", columns], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {}
  }
  return [];
}

/**
 * Which of `rows` still run, by `table`, plus what they started since, parents first.
 * Gone: no row, a zombie, or another start (the PID was reused). A failed read (`[]`) means none.
 */
export function stillRunning(rows: ProcRow[], table: ProcRow[]): ProcRow[] {
  const now = new Map(table.map((r) => [r.pid, r]));
  const out: ProcRow[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const row = now.get(r.pid);
    if (!row || row.start !== r.start || seen.has(r.pid)) continue;
    for (const p of [row.pid, ...descendants(table, row.pid)]) {
      const found = now.get(p)!;
      if (seen.has(p) || found.zombie) continue;
      seen.add(p);
      out.push(found);
    }
  }
  return out;
}

/** Send `sig` to each, and keep the ones it reached: ESRCH is gone, EPERM is not ours to wait on. */
export function signalAll(rows: ProcRow[], sig: NodeJS.Signals | number): ProcRow[] {
  return rows.filter((r) => {
    try {
      process.kill(r.pid, sig);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * SIGKILL the child, everything it started, and what is left of `known` with what that
 * started since, so a grandchild cannot keep a port busy. Returns what it reached besides
 * the child.
 */
export function killTree(child: ChildProcess | undefined, known: ProcRow[] = []): ProcRow[] {
  const pid = child?.pid;
  if (process.platform === "win32") {
    if (child && pid !== undefined) {
      const taskkill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.on("error", () => child.kill());
    }
    return [];
  }
  // One snapshot before the first kill: orphans are re-parented and would be lost.
  const table = processTable();
  const rows = stillRunning(pid === undefined ? known : [...subtree(table, pid), ...known], table);
  child?.kill("SIGKILL");
  return signalAll(rows, "SIGKILL");
}
