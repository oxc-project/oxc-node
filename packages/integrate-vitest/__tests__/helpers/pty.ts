import { spawn, spawnSync } from "node:child_process";

/**
 * Runs a command in a real terminal, through Python's `pty` module (Node.js has
 * none). The command leads a new session with the pty as its terminal, so a
 * Ctrl+C written to it reaches the whole foreground group, as it does by hand.
 */
export const HAS_PTY =
  process.platform !== "win32" &&
  spawnSync("python3", ["-I", "-c", "import pty"], { stdio: "ignore" }).status === 0;

/** Wait for `wait` (a Python regex) in the output since the last step, then write `send`. */
export interface PtyStep {
  wait: string;
  /** How long to wait after the match before writing. */
  delay?: number;
  send: string;
}

export interface PtyResult {
  out: string;
  code: number | null;
  signal: number | null;
  /** The steps that ran before the output stopped or the time ran out. */
  done: number;
  timedOut: boolean;
}

const SCRIPT = String.raw`
import json, os, pty, re, select, signal, sys, time
argv, steps, timeout = json.loads(sys.argv[1]), json.loads(sys.argv[2]), float(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out, pos, done, timed_out = b"", 0, 0, False
deadline = time.time() + timeout
def read(until=None):
    global out, pos, timed_out
    while True:
        if until is not None:
            m = re.search(until.encode(), out[pos:])
            if m:
                pos += m.end()
                return True
        left = deadline - time.time()
        if left <= 0:
            timed_out = True
            return False
        r, _, _ = select.select([fd], [], [], min(left, 0.05))
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            out += data
for step in steps:
    if not read(step["wait"]):
        break
    time.sleep(step.get("delay", 0) / 1000)
    try:
        os.write(fd, step["send"].encode())
    except OSError:  # the terminal closed: everything in it has exited
        break
    done += 1
read()
code = sig = None
while True:
    p, status = os.waitpid(pid, os.WNOHANG)
    if p:
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
        sig = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
        break
    if time.time() > deadline:
        timed_out = True
        os.kill(pid, signal.SIGKILL)
    time.sleep(0.02)
# Whatever is left of the session's group, such as an orphaned app.
try:
    os.killpg(pid, signal.SIGKILL)
except OSError:
    pass
print(json.dumps({"out": out.decode("utf-8", "replace"), "code": code, "signal": sig,
                  "done": done, "timedOut": timed_out}))
`;

export function runInPty(
  argv: string[],
  steps: PtyStep[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number },
): Promise<PtyResult> {
  const timeout = (o.timeout ?? 20_000) / 1000;
  const child = spawn(
    "python3",
    ["-I", "-c", SCRIPT, JSON.stringify(argv), JSON.stringify(steps), String(timeout)],
    { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(stdout) as PtyResult);
      } catch {
        reject(new Error(`pty helper exited ${code}: ${stdout}`));
      }
    });
  });
}
