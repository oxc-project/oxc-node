import { join } from "node:path";
import { afterAll, afterEach, describe, test } from "vitest";

import { EMULATED, MAJOR, project, removeProjects, startOxnode, stopAll } from "./helpers/watch.js";

/**
 * `oxnode --watch` is Node.js' own watch mode. It restarts on what the app
 * reports over IPC, and oxc-node adds the tsconfig files it read and the paths
 * a failed resolve looked for (issue #450). Node.js' watcher has no "ready"
 * line, so each edit is written again until the app shows it.
 */
afterEach(stopAll);
afterAll(removeProjects);

const ESM = JSON.stringify({ private: true, type: "module" });
const KEEP = "setInterval(() => {}, 1000);\n";
const paths = (dir: string) =>
  JSON.stringify({ compilerOptions: { paths: { "@lib/*": [`./${dir}/*`] } } });

// Each folder's value.ts exports its own name.
const values = Object.fromEntries(
  ["a", "b"].map((dir) => [`${dir}/value.ts`, `export const v: string = "${dir}";\n`]),
);
const ALIASED = `import { v } from "@lib/value";\nconsole.log("RUN", v, process.pid);\n${KEEP}`;

// One test at a time (Vitest 5 runs a file's tests in order; it has no `describe.sequential`).
describe.skipIf(EMULATED)("oxnode --watch", () => {
  test("a tsconfig paths edit restarts", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": paths("a"),
      "main.ts": ALIASED,
      ...values,
    });
    const o = startOxnode(["--watch", "main.ts"], root);
    await o.waitFor(/^RUN a \d+\n/m);
    await o.editUntil(join(root, "tsconfig.json"), () => paths("b"), /^RUN b \d+\n/m);
  });

  test("an edit to the config it extends restarts", async () => {
    const root = project({
      "package.json": ESM,
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "config/base.json": paths("../a"),
      "main.ts": ALIASED,
      ...values,
    });
    const o = startOxnode(["--watch", "main.ts"], root);
    await o.waitFor(/^RUN a \d+\n/m);
    await o.editUntil(join(root, "config/base.json"), () => paths("../b"), /^RUN b \d+\n/m);
  });

  // Node.js 22 and 24 on Linux watch each reported file itself, which fails for
  // one that does not exist; Node.js 26 watches its folder there too.
  test.skipIf(process.platform === "linux" && MAJOR < 26)(
    "creating the x.ts that ./x.js looked for restarts",
    async () => {
      const root = project({
        "package.json": ESM,
        "main.ts": `const x = await import("./x.js").then((m) => m.v as string, () => "none");
console.log("RUN", x, process.pid);
${KEEP}`,
      });
      const o = startOxnode(["--watch", "main.ts"], root);
      await o.waitFor(/^RUN none \d+\n/m);
      await o.editUntil(
        join(root, "x.ts"),
        () => 'export const v: string = "found";\n',
        /^RUN found \d+\n/m,
      );
    },
  );
});
