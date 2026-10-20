import process from "node:process";

// Read on first use: the bundle is loaded for plain runs too, and they must not touch stdout.
let color: boolean | undefined;

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM:SS [oxnode] msg` on stdout, like tsx and Node.js. */
export function log(msg: string): void {
  const d = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  color ??= Boolean(process.stdout.isTTY && process.stdout.hasColors?.());
  process.stdout.write(
    color
      ? `\x1b[90m${time}\x1b[39m \x1b[36m[oxnode]\x1b[39m ${msg}\n`
      : `${time} [oxnode] ${msg}\n`,
  );
}

const debugOn = Boolean(process.env.OXNODE_WATCH_DEBUG);

/** Lines on stderr that tests wait for (OXNODE_WATCH_DEBUG=1). */
export function debug(line: string): void {
  if (debugOn) process.stderr.write(`${line}\n`);
}
