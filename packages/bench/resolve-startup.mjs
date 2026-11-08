// Compare built checkouts through the oxnode CLI, including its child process.
// node packages/bench/resolve-startup.mjs --before <root> --after <root> --output <new-dir>
// Optional: --node <binary> (repeatable), --knip <checkout> --marked <checkout>, --runs 40
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    before: { type: "string" },
    after: { type: "string" },
    output: { type: "string" },
    node: { type: "string", multiple: true, default: [process.execPath] },
    knip: { type: "string" },
    marked: { type: "string" },
    runs: { type: "string", default: "40" },
  },
});
assert(values.before && values.after && values.output, "Pass --before, --after and --output");
assert(Boolean(values.knip) === Boolean(values.marked), "Pass both --knip and --marked");
const runs = Number(values.runs);
assert(
  Number.isSafeInteger(runs) && runs > 0 && runs % 2 === 0,
  "--runs must be positive and even",
);
mkdirSync(values.output, { recursive: false, mode: 0o700 });
const output = realpathSync(values.output);
for (let dir = output; ; dir = path.dirname(dir)) {
  assert(
    !lstatSync(path.join(dir, "tsconfig.json"), { throwIfNoEntry: false }),
    "Choose an output directory without an ancestor tsconfig.json",
  );
  if (dir === path.dirname(dir)) break;
}
const roots = { before: realpathSync(values.before), after: realpathSync(values.after) };
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function javascriptFiles(dir, relative = "") {
  return readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(relative, entry.name);
    if (entry.name === "node_modules") return [];
    if (entry.isDirectory()) return javascriptFiles(dir, name);
    return /\.(?:[cm]?js|json|ts)$/.test(name) ? [name] : [];
  });
}
const hashes = Object.fromEntries(
  Object.entries(roots).map(([label, root]) => {
    const javascript = {};
    for (const pkg of ["core", "cli"]) {
      const dir = path.join(root, "packages", pkg);
      for (const file of javascriptFiles(dir)) {
        javascript[path.join(pkg, file)] = digest(path.join(dir, file));
      }
    }
    const core = path.join(root, "packages/core");
    const native = Object.fromEntries(
      readdirSync(core)
        .filter((name) => name.endsWith(".node"))
        .map((name) => [realpathSync(path.join(core, name)), digest(path.join(core, name))]),
    );
    assert(Object.keys(native).length, "Each checkout must contain a built native binding");
    return [label, { javascript, native }];
  }),
);
assert.deepEqual(hashes.before.javascript, hashes.after.javascript, "Only native code may differ");

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(?:NODE_|OXC_|OXNODE_|TS_NODE_|BENCH_|NAPI_RS_|DYLD_|DEBUG$)/i.test(key),
  ),
);
const nodes = [...new Set(values.node.map((node) => realpathSync(node)))].map((file) => {
  const result = spawnSync(file, ["--version"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return { file, version: result.stdout.trim().replace(/^v/, "") };
});
const probe = path.join(output, "node_modules/oxc-startup-probe/probe.cjs");
mkdirSync(path.dirname(probe), { recursive: true });
writeFileSync(
  probe,
  `if (require("node:worker_threads").isMainThread) {
  process.once("exit", () => {
    const path = require("node:path");
    const core = require("node:fs").realpathSync(process.env.BENCH_CORE);
    const native = Object.keys(require.cache).filter(
      (file) => file.startsWith(core + path.sep) && file.endsWith(".node"),
    );
    process.stdout.write("\\n" + process.env.BENCH_TOKEN + JSON.stringify({
      node: process.versions.node, execPath: process.execPath, native,
      compileCache: require("node:module").getCompileCacheDir() ?? null,
    }) + "\\n");
  });
}\n`,
);

function moduleSource(i) {
  return `export interface Item${i} { id: number; name: string; }
export enum Kind${i} { A = 'a${i}', B = 'b${i}' }
export class Store${i} {
  items: Item${i}[] = [];
  constructor(private readonly prefix: string) {}
  add(id: number): Item${i} {
    const item = { id, name: \`\${this.prefix}-\${id}\` };
    this.items.push(item);
    return item;
  }
}
export function run${i}(): number { return new Store${i}(Kind${i}.A).add(${i}).id; }
`;
}
const cases = [300, 1000, 10000].map((count) => {
  const cwd = path.join(output, "fixtures", String(count));
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "package.json"), '{ "type": "module" }\n');
  for (let i = 0; i < count; i++) writeFileSync(path.join(cwd, `mod${i}.ts`), moduleSource(i));
  const entry = path.join(cwd, "index.ts");
  writeFileSync(
    entry,
    [
      ...Array.from({ length: count }, (_, i) => `import { run${i} } from './mod${i}.ts';`),
      "let total = 0;",
      ...Array.from({ length: count }, (_, i) => `total += run${i}();`),
      "console.log('total', total);\n",
    ].join("\n"),
  );
  return {
    name: `${count} ESM modules`,
    cwd,
    entry,
    args: [],
    expected: `total ${(count * (count - 1)) / 2}`,
  };
});
if (values.knip) {
  const cwd = realpathSync(values.knip);
  cases.push({
    name: "Knip scanning Marked",
    cwd,
    entry: path.join(cwd, "packages/knip/src/cli.ts"),
    args: [
      "--directory",
      realpathSync(values.marked),
      "--production",
      "--include",
      "files,exports",
      "--reporter",
      "json",
      "--no-exit-code",
    ],
    json: true,
  });
}
const report = {
  timestamp: new Date().toISOString(),
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model },
  roots,
  hashes,
  nodes,
  cases,
  runs,
  metric: "oxnode CLI launch through exit, including its child process and the full application",
  rows: [],
};
const resultsFile = path.join(output, "results.json");
function normalize(test, text) {
  if (!test.json) return text.trim();
  const value = JSON.parse(text);
  assert(Array.isArray(value.issues));
  assert.equal(new Set(value.issues.map((issue) => issue.file)).size, value.issues.length);
  value.issues.sort((a, b) => a.file.localeCompare(b.file));
  return value;
}
function launch(node, test, label, phase, block) {
  const root = roots[label];
  const token = `OXCNODE_BENCH_${randomUUID()}:`;
  const start = performance.now();
  const result = spawnSync(
    node.file,
    [path.join(root, "packages/cli/dist/index.js"), "--require", probe, test.entry, ...test.args],
    {
      cwd: test.cwd,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...env,
        PATH: path.dirname(node.file) + path.delimiter + (env.PATH ?? ""),
        NODE_DISABLE_COMPILE_CACHE: "1",
        BENCH_CORE: path.join(root, "packages/core"),
        BENCH_TOKEN: token,
      },
    },
  );
  const ms = performance.now() - start;
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parts = result.stdout.split(token);
  assert.equal(parts.length, 2, "The application must report its binding and runtime exactly once");
  const observed = JSON.parse(parts[1]);
  assert.equal(observed.node, node.version);
  assert.equal(realpathSync(observed.execPath), node.file);
  assert.equal(observed.compileCache, null);
  assert.equal(observed.native.length, 1);
  assert(Object.hasOwn(hashes[label].native, realpathSync(observed.native[0])));
  const value = normalize(test, parts[0]);
  test.expected ??= value;
  assert.deepEqual(value, test.expected);
  report.rows.push({ node: node.version, case: test.name, label, phase, block, ms });
  writeFileSync(resultsFile, JSON.stringify(report, null, 2));
  console.log(`Node ${node.version} ${test.name} ${label} ${phase} ${block} ${ms.toFixed(1)} ms`);
}
for (const node of nodes) {
  for (const test of cases) {
    for (let i = 0; i < 3; i++) {
      for (const label of ["before", "after"]) launch(node, test, label, "prime", i);
    }
  }
}
for (let block = 0; block < runs; block++) {
  for (const node of nodes) {
    for (const test of cases) {
      for (const label of block % 2 ? ["after", "before"] : ["before", "after"]) {
        launch(node, test, label, "warm", block);
      }
    }
  }
}
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor(sorted.length / 2)] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
};
report.medians = nodes.flatMap((node) =>
  cases.map((test) => {
    const row = { node: node.version, case: test.name };
    for (const label of ["before", "after"]) {
      row[label] = median(
        report.rows
          .filter(
            (r) =>
              r.node === node.version &&
              r.case === test.name &&
              r.label === label &&
              r.phase === "warm",
          )
          .map((r) => r.ms),
      );
    }
    row.reductionPercent = (1 - row.after / row.before) * 100;
    return row;
  }),
);
writeFileSync(resultsFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.medians, null, 2));
