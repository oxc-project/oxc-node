// oxc-node compiles these files to CommonJS only where Node.js can `require()` an ES
// module from a file its module loader ran: 22.22.3, 24.8 and later. Elsewhere they run
// as ES modules, as before, where their import cycles and CommonJS imports do not
// apply, so there is nothing here to test.
import { spawnSync } from "node:child_process";

const [major, minor, patch] = process.versions.node.split(".", 3).map(Number);
const lowers =
  major === 22
    ? minor > 22 || (minor === 22 && patch >= 3)
    : major === 24
      ? minor >= 8
      : major >= 25;
if (!lowers) {
  console.log(`skipped: Node.js ${process.version} keeps ES modules`);
  process.exit(0);
}
const { status, signal } = spawnSync(
  process.execPath,
  ["../cli/dist/index.js", "--test", "src/*.test.ts"],
  { stdio: "inherit" },
);
process.exit(status ?? (signal ? 1 : 0));
