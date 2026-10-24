import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";

const CORE = fileURLToPath(new URL("../../core", import.meta.url));
const FIELDS = `let writes = 0;
class Base { set value(value: number) { writes++; } }
class Child extends Base { value = 1; }
new Child();
module.exports = writes;
`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oxc-worker-context-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(CORE, join(root, "node_modules", "@oxc-node", "core"), "dir");
  const common: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    "fields.cts": FIELDS,
  };
  for (const name of ["default", "parent", "one", "two"]) {
    common[`${name}.ts`] = `export const value: string = ${JSON.stringify(name)};\n`;
    common[name === "default" ? "tsconfig.json" : `${name}.json`] = JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: name !== "one",
        paths: { "@value": [`./${name}.ts`] },
      },
    });
  }
  for (const [name, contents] of Object.entries({ ...common, ...files })) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

function environment(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: undefined,
    OXC_LOG: undefined,
    DEBUG: undefined,
    TS_NODE_PROJECT: undefined,
    OXC_TSCONFIG_PATH: undefined,
    OXC_TRANSFORM_ALL: undefined,
    ...env,
  };
}

function run(root: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: environment(env),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
}

// One pool thread makes transforms from all JavaScript threads reuse the same
// native thread. Each async task must carry its caller's configuration with it.
test("workers isolate explicit configs and dependency modes for sync and async transforms", () => {
  const root = fixture({
    "api.mjs": `import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  OxcTransformer, getTsconfigPath, getTransformDeps, setTsconfigPath,
  setTransformDeps, transformsDep,
} from "@oxc-node/core";

const selection = isMainThread
  ? { config: "parent.json", mode: "off", writes: 0 }
  : workerData;
setTsconfigPath(selection.config);
setTransformDeps(selection.mode);
const transformer = new OxcTransformer(process.cwd());
const source = readFileSync("fields.cts", "utf8");
function check(output) {
  const module = { exports: undefined };
  new Function("module", output.source())(module);
  assert.equal(module.exports, selection.writes);
  assert.equal(getTsconfigPath(), selection.config);
  assert.equal(getTransformDeps(), selection.mode);
  assert.equal(transformsDep("node_modules/dep/index.ts"), selection.mode !== "off");
  assert.equal(transformsDep("node_modules/dep/index.js"), selection.mode === "all");
}
async function transforms() {
  for (let i = 0; i < 8; i++) {
    check(transformer.transform("fields.cts", source));
    check(await transformer.transformAsync("fields.cts", source));
  }
}
check(transformer.transform("fields.cts", source));
if (isMainThread) {
  const workers = [
    { config: "one.json", mode: "typescript", writes: 1 },
    { config: "two.json", mode: "all", writes: 0 },
  ].map(workerData => new Worker(new URL(import.meta.url), { workerData }));
  try {
    await Promise.all(workers.map(worker => once(worker, "message")));
    const completed = Promise.all(workers.map(worker => once(worker, "exit")));
    for (const worker of workers) worker.postMessage("run");
    const [, exits] = await Promise.all([transforms(), completed]);
    for (const [code] of exits) assert.equal(code, 0);
    await transforms();
    console.log("ok");
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
} else {
  const ready = once(parentPort, "message");
  parentPort.postMessage("ready");
  await ready;
  await transforms();
  parentPort.close();
}
`,
  });
  run(root, ["./api.mjs"], { UV_THREADPOOL_SIZE: "1" });
});

test("registered workers use their own environment for aliases, transforms and dependency modes", () => {
  const root = fixture({
    "node_modules/ts-dep/package.json": JSON.stringify({ name: "ts-dep", main: "index.cts" }),
    "node_modules/ts-dep/index.cts":
      "enum Value { Current = 7 }\nmodule.exports = Value.Current;\n",
    "check.mjs": `import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export async function check(expected) {
  const { value } = await import("@value");
  delete require.cache[require.resolve("./fields.cts")];
  assert.equal(value, expected.value);
  assert.equal(require("./fields.cts"), expected.writes);
  delete require.cache[require.resolve("ts-dep")];
  if (expected.dependency) assert.equal(require("ts-dep"), 7);
  else assert.throws(() => require("ts-dep"));
}
`,
    "worker.mts": `import assert from "node:assert/strict";
import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { value } from "@value";
import { check } from "./check.mjs";

// Static imports resolve before this thread can send its first message.
assert.equal(value, workerData.value);
const ready = once(parentPort!, "message");
parentPort!.postMessage("ready");
await ready;
await check(workerData);
parentPort!.close();
`,
    "main.mjs": `import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { check } from "./check.mjs";

const parent = { value: "parent", writes: 0, dependency: true };
const original = { ...process.env };
await check(parent);
const selections = [
  { env: { TS_NODE_PROJECT: "one.json", OXC_TSCONFIG_PATH: "two.json", OXC_TRANSFORM_ALL: "typescript" }, value: "one", writes: 1, dependency: true },
  { env: { OXC_TSCONFIG_PATH: "two.json", OXC_TRANSFORM_ALL: "0" }, value: "two", writes: 0, dependency: false },
  { env: {}, value: "default", writes: 0, dependency: false },
];
const workers = selections.map(({ env: selected, ...workerData }) => {
  const env = { ...process.env };
  delete env.TS_NODE_PROJECT;
  delete env.OXC_TSCONFIG_PATH;
  delete env.OXC_TRANSFORM_ALL;
  return new Worker(new URL("./worker.mts", import.meta.url), {
    env: { ...env, ...selected }, workerData,
  });
});

try {
  await Promise.all(workers.map(worker => once(worker, "message")));
  const completed = Promise.all(workers.map(worker => once(worker, "exit")));
  for (const worker of workers) worker.postMessage("run");
  const [, exits] = await Promise.all([check(parent), completed]);
  for (const [code] of exits) assert.equal(code, 0);
  await check(parent);
  assert.deepEqual({ ...process.env }, original);
  console.log("ok");
} finally {
  await Promise.all(workers.map(worker => worker.terminate()));
}
`,
  });
  run(root, ["--import", "@oxc-node/core/register", "./main.mjs"], {
    TS_NODE_PROJECT: "parent.json",
    OXC_TSCONFIG_PATH: "parent.json",
    OXC_TRANSFORM_ALL: "typescript",
  });
});

test("raw transform APIs capture the worker environment at the first call, including async calls", () => {
  const root = fixture({
    "environment.mjs": `import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { OxcTransformer, transform, transformAsync, transformsDep } from "@oxc-node/core";

const transformer = new OxcTransformer(process.cwd());
const source = readFileSync("fields.cts", "utf8");
function writes(output) {
  const module = { exports: undefined };
  new Function("module", output.source())(module);
  return module.exports;
}
if (isMainThread) {
  // Initialize the parent's native context before any worker imports the binding.
  assert.equal(writes(transformer.transform("fields.cts", source)), 1);
  const workers = [
    { method: "class", async: false, clear: true, mode: "all" },
    { method: "class", async: true, clear: false, mode: "typescript" },
    { method: "function", async: false, clear: false, mode: "all" },
    { method: "function", async: true, clear: true, mode: "typescript" },
  ].map(workerData => new Worker(new URL(import.meta.url), { workerData }));
  try {
    for (const [code] of await Promise.all(workers.map(worker => once(worker, "exit")))) {
      assert.equal(code, 0);
    }
    assert.equal(writes(await transformer.transformAsync("fields.cts", source)), 1);
    assert.equal(transformsDep("node_modules/dep/index.ts"), false);
    console.log("ok");
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
} else {
  // Binding import and transformer construction must not freeze the environment.
  if (workerData.clear) {
    delete process.env.TS_NODE_PROJECT;
    delete process.env.OXC_TSCONFIG_PATH;
  } else {
    process.env.TS_NODE_PROJECT = "two.json";
    process.env.OXC_TSCONFIG_PATH = "one.json";
  }
  process.env.OXC_TRANSFORM_ALL = workerData.mode;
  let run;
  if (workerData.method === "class") {
    run = workerData.async
      ? transformer.transformAsync.bind(transformer)
      : transformer.transform.bind(transformer);
  } else {
    run = workerData.async ? transformAsync : transform;
  }
  const result = run("fields.cts", source);
  // A queued async transform must use the environment at its call, rather than
  // the environment later observed by the shared libuv pool thread.
  process.env.TS_NODE_PROJECT = "one.json";
  process.env.OXC_TRANSFORM_ALL = "0";
  assert.equal(writes(await result), 0);
  assert.equal(writes(await transformer.transformAsync("fields.cts", source)), 0);
  assert.equal(transformsDep("node_modules/dep/index.ts"), true);
  assert.equal(transformsDep("node_modules/dep/index.js"), workerData.mode === "all");
}
`,
  });
  run(root, ["./environment.mjs"], {
    TS_NODE_PROJECT: "one.json",
    OXC_TSCONFIG_PATH: "one.json",
    OXC_TRANSFORM_ALL: "0",
    UV_THREADPOOL_SIZE: "1",
  });
});

test("asynchronous registration freezes the config before the main and hook threads can diverge", () => {
  const root = fixture({
    "late.mjs": `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTsconfigPath, setTransformDeps } from "@oxc-node/core";

setTsconfigPath("one.json");
setTransformDeps("typescript");
await import("@oxc-node/core/register");
const [major, minor] = process.versions.node.split(".").map(Number);
const synchronous = major > 26 || (major === 26 && minor >= 2);
if (synchronous) {
  // In-thread hooks keep the existing first-resolve/transform deadline.
  setTsconfigPath("two.json");
} else {
  // The off-thread hooks already received their snapshot at registration.
  assert.throws(() => setTsconfigPath("two.json"), /before the first transform or resolve/);
  assert.throws(() => setTransformDeps("off"), /before the first transform or resolve/);
  setTsconfigPath("one.json");
}
process.env.TS_NODE_PROJECT = "parent.json";
const require = createRequire(import.meta.url);
assert.equal((await import("@value")).value, synchronous ? "two" : "one");
assert.equal(require("./fields.cts"), synchronous ? 0 : 1);
console.log("ok");
`,
  });
  run(root, ["./late.mjs"]);
});

test("a queued asynchronous transform freezes its caller's config before a later synchronous call", async () => {
  const root = fixture({
    "queued.mjs": `import assert from "node:assert/strict";
import { read, readFileSync } from "node:fs";
import { OxcTransformer, setTsconfigPath, setTransformDeps, transformsDep } from "@oxc-node/core";

// Occupy the sole libuv pool thread until the test parent writes to stdin.
// Unlike CPU work or a timer, this cannot finish before the parent releases it.
const blocked = new Promise((resolve, reject) => {
  read(0, Buffer.alloc(1), 0, 1, null, (error, bytes) => {
    if (error) reject(error);
    else { assert.equal(bytes, 1); resolve(); }
  });
});
const transformer = new OxcTransformer(process.cwd());
const source = readFileSync("fields.cts", "utf8");
function writes(output) {
  const module = { exports: undefined };
  new Function("module", output.source())(module);
  return module.exports;
}
process.env.TS_NODE_PROJECT = "one.json";
process.env.OXC_TRANSFORM_ALL = "typescript";
const first = transformer.transformAsync("fields.cts", source);
process.env.TS_NODE_PROJECT = "two.json";
process.env.OXC_TRANSFORM_ALL = "0";
assert.equal(writes(transformer.transform("fields.cts", source)), 1);
assert.equal(transformsDep("node_modules/dep/index.ts"), true);
assert.throws(() => setTsconfigPath("two.json"), /before the first transform or resolve/);
assert.throws(() => setTransformDeps("off"), /before the first transform or resolve/);
console.log("release");
await blocked;
assert.equal(writes(await first), 1);
console.log("ok");
`,
  });
  const child = spawn(process.execPath, ["./queued.mjs"], {
    cwd: root,
    env: environment({ UV_THREADPOOL_SIZE: "1" }),
    signal: AbortSignal.timeout(30_000),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let released = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!released && stdout.includes("release\n")) {
      released = true;
      child.stdin.end("x");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const [status] = await once(child, "close");
    expect(status, stdout + stderr).toBe(0);
    expect(stdout.trim()).toBe("release\nok");
  } finally {
    child.kill();
  }
});
