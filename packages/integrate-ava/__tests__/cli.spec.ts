import test, { ExecutionContext } from "ava";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const STACKTRACE_LINE = 6;
const STACKTRACE_COLUMN = 12;
const FIXTURE_PATHS = new Map(
  ["stacktrace-esm.ts", "stacktrace-esm.mts", "stacktrace-cjs.cts"].map((name) => [
    name,
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
  ]),
);
const getFixturePath = (fixtureName: string) => {
  const resolved = FIXTURE_PATHS.get(fixtureName);
  if (!resolved) {
    throw new Error(`Unknown fixture: ${fixtureName}`);
  }
  return resolved;
};
const runCliFixture = (fixtureName: string) => {
  const fixturePath = getFixturePath(fixtureName);
  const result = spawnSync(
    process.execPath,
    ["--import", "@oxc-node/core/register", "--test", fixturePath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
      },
    },
  );

  return { ...result, fixturePath };
};
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expectStackLocation = (t: ExecutionContext, output: string, fixturePath: string) => {
  const fileUrl = pathToFileURL(fixturePath).href;
  const pattern = new RegExp(
    `(?:${escapeRegExp(fileUrl)}|${escapeRegExp(fixturePath)}):(\\d+):(\\d+)`,
    "g",
  );
  const matches = [...output.matchAll(pattern)];

  t.true(matches.length > 0, "stack trace should reference the failing fixture path");

  const exactLocation = matches.find(([, line, column]) => {
    return Number(line) === STACKTRACE_LINE && Number(column) === STACKTRACE_COLUMN;
  });

  t.truthy(exactLocation, "stack trace should include the original TypeScript location");
};

for (const fixture of FIXTURE_PATHS.keys()) {
  test(`CLI stack trace for ${fixture}`, (t) => {
    const { stdout, stderr, status, error, fixturePath } = runCliFixture(fixture);

    t.falsy(error, error?.message);
    t.not(status, 0, "fixture should fail to trigger stack trace output");

    expectStackLocation(t, `${stdout}${stderr}`, fixturePath);
  });
}
