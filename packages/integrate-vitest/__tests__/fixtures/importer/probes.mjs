// Usage: node --expose-gc probes.mjs <path to @oxc-node/core/importer>
// Behaviour beyond the parity checks: stack lines, require() of ES modules, cycles,
// live bindings, `export *`, retries, memory and leaks. One JSON line per probe.
import fs, { realpathSync } from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "probes");
const req = createRequire(import.meta.url);
const extensionsBefore = Object.keys(req.extensions).join(",");
const sourceMapsBefore = process.sourceMapsEnabled;
const { createImporter } = await import(pathToFileURL(process.argv[2]).href);
const imp = createImporter(path.join(DIR, "host.mjs"));

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
// The memory probes load many files; a slow machine needs more than the usual 5 s.
async function probe(check, fn, ms = 5000) {
  let result;
  try {
    const [ok, detail] = await Promise.race([fn(), timeout(ms)]);
    result = { check, ok, detail: String(detail) };
  } catch (e) {
    result = { check, ok: false, detail: `threw ${e?.code ?? ""} ${String(e?.message).split("\n")[0]}` };
  }
  console.log(JSON.stringify(result));
}
const frame = (error, file) => error.stack.split("\n").find((line) => line.includes(file)) ?? "";

// A frame of code that runs after import() still names the TypeScript line: the
// output keeps each line where the source has it.
await probe("stack-line-after-import", async () => {
  const m = await imp.import("./thrower.ts");
  try {
    m.boom();
  } catch (e) {
    const line = frame(e, "thrower.ts");
    return [/thrower\.ts:7:\d+\)?$/.test(line), line.trim()];
  }
  return [false, "no throw"];
});
// An error that leaves import() gets line and column from the source map.
await probe("stack-mapped-escaping-import", async () => {
  try {
    await imp.import("./top-throw.ts");
  } catch (e) {
    const line = frame(e, "top-throw.ts");
    return [/top-throw\.ts:6:11\)?$/.test(line) && !line.includes("?"), line.trim()];
  }
  return [false, "no throw"];
});
await probe("cts-requires-esm-ts", async () => {
  const m = await imp.import("./req-esm.cts", { default: true });
  return [m?.got === 5, JSON.stringify(m)];
});
await probe("cts-requires-esm-graph", async () => {
  const out = await imp.import("./req-chain.cts", { default: true });
  return [out === "b.ts:probe-data:10", out];
});
await probe("require-tla-is-async-module-error", async () => {
  const code = await imp.import("./req-tla.cts", { default: true });
  return [code === "ERR_REQUIRE_ASYNC_MODULE", code];
});
// Loaded by import() first, so the require() finds them in the cache.
await probe("require-cached-tla-is-async-module-error", async () => {
  await imp.import("./tla-parent.ts");
  const requireLater = await imp.import("./req-tla-later.cts", { default: true });
  const codes = [requireLater("./tla-dep.mts"), requireLater("./tla-parent.ts")];
  return [codes.every((code) => code === "ERR_REQUIRE_ASYNC_MODULE"), codes.join(" ")];
});
// The top-level await is in a node_modules package that Node.js loads itself.
await probe("require-cached-native-tla-is-async-module-error", async () => {
  const fromProject = createImporter(path.join(DIR, "..", "project", "tla-native", "x.ts"));
  await fromProject.import("./parent.mts");
  const requireLater = await fromProject.import("./req-later.cts", { default: true });
  const code = requireLater("./parent.mts");
  return [code === "ERR_REQUIRE_ASYNC_MODULE", code];
});
await probe("default-and-namespace-import", async () => {
  const m = await imp.import("./default-ns.ts");
  return [m.both === "fk", m.both];
});
// Still waiting on its dependency's top-level await when the require() comes.
await probe("require-evaluating-tla-is-async-module-error", async () => {
  const release = Promise.withResolvers();
  globalThis.__releaseSlowTla = release.promise;
  const pending = imp.import("./slow-parent.ts");
  const requireLater = await imp.import("./req-tla-later.cts", { default: true });
  const code = requireLater("./slow-parent.ts");
  release.resolve();
  await pending;
  return [code === "ERR_REQUIRE_ASYNC_MODULE", code];
});
await probe("require-resolve-paths", async () => {
  const m = await imp.import("./resolve-paths.cts", { default: true });
  const expected = createRequire(path.join(DIR, "resolve-paths.cts")).resolve.paths("some-package");
  const ok =
    JSON.stringify(m.paths) === JSON.stringify(expected) &&
    m.builtin === null &&
    m.withPaths.includes(`${path.sep}fake-dep${path.sep}`) &&
    m.hasMain === true;
  return [ok, `${m.paths?.[0]} ${m.builtin} ${m.withPaths} main:${m.hasMain}`];
});
// Babel/tsc CommonJS (`__esModule`): imports inside a runner file get `exports.default`;
// the module `import()` returns stays as Node.js gives it, and `default: true` unwraps a
// function default only, as in jiti.
await probe("esmodule-commonjs-interop", async () => {
  const fromProject = createImporter(path.join(DIR, "..", "project", "cjs-interop", "x.ts"));
  const m = await fromProject.import("./static.ts");
  const top = await fromProject.import("babel-object", { default: true });
  const plugin = await fromProject.import("babel-fn", { default: true });
  const got = [
    JSON.stringify(m.fromDefault),
    JSON.stringify(m.fromNamespace),
    m.helper,
    JSON.stringify(await m.lazy()),
    JSON.stringify(top),
    typeof plugin === "function" ? plugin() : typeof plugin,
    JSON.stringify(m.esm),
  ].join(" ");
  const want = '{"content":["a"]} {"content":["a"]} 1 {"content":["a"]} {"default":{"content":["a"]},"helper":1} plugin {"__esModule":true,"default":"inner"}';
  return [got === want, got];
});
// `__dirname`, `__filename` and `require` in an ES module, as jiti has them; a module
// declaring its own still works.
await probe("commonjs-variables-in-es-module", async () => {
  const fromProject = createImporter(path.join(DIR, "..", "project", "cjs-interop", "x.ts"));
  const vars = await fromProject.import("./cjs-vars.ts", { default: true });
  const own = await fromProject.import("./own-vars.ts", { default: true });
  const got = JSON.stringify([vars, own]);
  const want = JSON.stringify([
    { dir: "cjs-interop", file: "cjs-vars.ts", required: 42 },
    { own: "function", dir: "cjs-interop" },
  ]);
  return [got === want, got];
});
await probe("commonjs-hidden-named-export", async () => {
  const got = JSON.stringify(await imp.import("./hidden-import.ts", { default: true }));
  return [got === "[1,2]", got];
});
// A URL that is no file, such as `data:`, is Node.js' to load.
await probe("data-url", async () => {
  const m = await imp.import("./data-url.ts");
  const top = await imp.import("data:text/javascript,export default 5", { default: true });
  const required = await imp.import("./require-data-url.cts", { default: true });
  const got = [
    await m.viaData(),
    m.resolved,
    top,
    imp.resolve("data:text/javascript,1"),
    await m.viaJson(),
    m.resolvedUrl,
    required.resolved,
    required.code,
    required.stack === `- ${path.join(DIR, "require-data-url.cts")}`,
  ].join(" ");
  const want =
    "7 data:text/javascript,1 5 data:text/javascript,1 1 data:text/javascript,2 " +
    "data:text/javascript,1 MODULE_NOT_FOUND true";
  return [got === want, got];
});
await probe("cycle", async () => {
  const a = await imp.import("./cyc-a.ts");
  const b = await imp.import("./cyc-b.ts");
  return [a.getB() === "b" && b.getA() === "a", `${a.getB()} ${b.getA()}`];
});
await probe("parallel-cycle", async () => {
  const fresh = createImporter(path.join(DIR, "host.mjs"), { moduleCache: false });
  const [a, b] = await Promise.all([fresh.import("./cyc-a.ts"), fresh.import("./cyc-b.ts")]);
  return [a.getB() === "b" && b.getA() === "a", "ok"];
});
await probe("live-binding", async () => {
  const m = await imp.import("./live.ts");
  const before = m.count;
  m.inc();
  m.inc();
  return [m.count === before + 2, m.count];
});
await probe("export-star", async () => {
  const m = await createImporter(path.join(DIR, "host.mjs"), { interopDefault: false }).import(
    "./reexport.ts",
  );
  const live = await imp.import("./live.ts");
  live.inc();
  const keys = Object.keys(m).sort().join(",");
  const ok = keys === "Named,count,inc,live" && m.count === live.count && m.live.count === live.count;
  return [ok && m.Named.n === 3, `${keys} ${m.count}`];
});
// A name two `export *` sources give as different bindings is left out, as Node.js
// leaves it out; the same binding reached twice (a diamond) stays.
await probe("export-star-ambiguous", async () => {
  const raw = createImporter(path.join(DIR, "host.mjs"), { interopDefault: false });
  const ambiguous = await raw.import("./star-ambiguous.ts");
  const diamond = await raw.import("./star-diamond.ts");
  const keys = Object.keys(ambiguous).sort().join(",");
  const ok = keys === "fromA,fromB" && ambiguous.only1 === undefined && diamond.only1 === "a";
  return [ok, `${keys} ${ambiguous.only1} ${diamond.only1}`];
});
// Node.js gives a URL for a path that names no file, as it does for `./nope.js`.
await probe("import-meta-resolve-missing", async () => {
  const m = await imp.import("./meta-missing.ts");
  const ok =
    m.missing === new URL("nope.js", m.self).href &&
    m.missingUrl === "file:///definitely/missing.ts" &&
    // An imported module, where Node.js has `import.meta.main`.
    m.main === ("main" in import.meta ? false : undefined) &&
    m.hasMain === "main" in import.meta;
  return [ok, `${m.missing} ${m.missingUrl} main:${m.main} own:${m.hasMain}`];
});
// A directory parent uses the `tsconfig.json` in it, as a file in it does.
await probe("directory-parent-paths", async () => {
  const fromDir = createImporter(DIR + path.sep);
  const elsewhere = createImporter(path.join(DIR, "..") + path.sep);
  const results = [
    (await fromDir.import("@probes/ns.ts")).z,
    fromDir.resolve("@probes/ns.ts")?.endsWith("/probes/ns.ts"),
    (await elsewhere.import("@probes/ns", { parentURL: pathToFileURL(DIR + path.sep) })).z,
  ];
  return [results.join(",") === "1,true,1", results.join(",")];
});
// Node.js says the package does not export the path; `try` still gives `undefined`,
// as jiti does.
await probe("package-path-not-exported", async () => {
  const fromProject = createImporter(path.join(DIR, "..", "project", "host.ts"));
  const error = await fromProject.import("cond-dep/custom.js").then(
    () => undefined,
    (e) => e,
  );
  const tried = await fromProject.import("cond-dep/custom.js", { try: true });
  const ok =
    error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
    error.message.includes("imported from") &&
    tried === undefined;
  return [ok, `${error?.code} ${error?.message.split("\n")[0]} ${tried}`];
});
// Exported under `require` only: the import conditions do not match it.
await probe("package-path-exported-for-require-only", async () => {
  const fromProject = createImporter(path.join(DIR, "..", "project", "host.ts"));
  const codes = [];
  for (const id of ["require-only-dep/r", "require-only-dep"]) {
    const error = await fromProject.import(id).then(
      () => undefined,
      (e) => e,
    );
    codes.push(`${error?.code} ${error?.message.split("\n")[0]}`);
  }
  const ok =
    codes[0].startsWith("ERR_PACKAGE_PATH_NOT_EXPORTED Package subpath './r' is not defined") &&
    codes[1].startsWith('ERR_PACKAGE_PATH_NOT_EXPORTED No "exports" main defined');
  return [ok, codes.join(" | ")];
});
// A `#` alias the package does not define: Node.js' error, which `try: true` turns into
// `undefined`, as jiti does.
await probe("package-import-not-defined", async () => {
  const codes = [];
  for (const id of ["./hash-missing.ts", "./hash-missing.cts"]) {
    const error = await imp.import(id).then(
      () => undefined,
      (e) => e,
    );
    codes.push(`${error?.code} ${error?.message.includes("imported from")}`);
  }
  const tried = await imp.import("#missing", { try: true });
  const got = `${codes.join(" ")} ${tried}`;
  const want = "ERR_PACKAGE_IMPORT_NOT_DEFINED true ERR_PACKAGE_IMPORT_NOT_DEFINED true undefined";
  return [got === want, got];
});
await probe("new-Function-import", async () => {
  const m = await imp.import("./evalimp.ts");
  const z = await m.viaFn();
  return [z === 1, z];
});
await probe("lazy-import-after-return", async () => {
  const m = await imp.import("./lazy-host.ts");
  const [v, w] = [await m.later(), await m.laterExt()];
  return [v === 7 && w === 9, `${v} ${w}`];
});
await probe("failed-module-retried", async () => {
  const first = await imp.import("./fails-once.ts").then(
    () => "loaded",
    (e) => e.message,
  );
  const second = await imp.import("./fails-once.ts");
  return [first === "first-run" && second.ok === true, first];
});
await probe("hashbang", async () => {
  const m = await imp.import("./hashbang.ts");
  return [m.shebang === "ok", m.shebang];
});
// Bounded, not exact: 200 runs of a module with a 2000-entry array must not keep them.
await probe("memory-module-cache-false", async () => {
  const fresh = createImporter(path.join(DIR, "host.mjs"), { moduleCache: false });
  for (let i = 0; i < 20; i++) await fresh.import("./small.ts");
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) await fresh.import("./small.ts");
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.gc();
  const kb = (process.memoryUsage().heapUsed - before) / 200 / 1024;
  return [kb < 16, `${kb.toFixed(1)} KB per import`];
});
// Every import a new file: nothing of a finished graph, its source maps included, stays.
await probe("memory-module-cache-false-new-files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxc-node-importer-files-"));
  try {
    const body = Array.from({ length: 1200 }, (_, i) => `export const v${i}: number = ${i};`).join("\n");
    const files = Array.from({ length: 120 }, (_, i) => {
      const file = path.join(dir, `m${i}.ts`);
      fs.writeFileSync(file, body);
      return file;
    });
    const fresh = createImporter(path.join(dir, "host.mjs"), { moduleCache: false });
    // A plain `gc()` leaves garbage unswept in `heapUsed`; the last-resort one does not.
    const collect = () => globalThis.gc({ type: "major", execution: "sync", flavor: "last-resort" });
    for (const file of files.slice(0, 20)) await fresh.import(file);
    collect();
    const before = process.memoryUsage().heapUsed;
    for (const file of files.slice(20)) await fresh.import(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    collect();
    const kb = (process.memoryUsage().heapUsed - before) / 100 / 1024;
    return [kb < 2, `${kb.toFixed(1)} KB per file`];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
// Every import a new file that throws: a failed module leaves nothing behind either.
await probe("memory-failed-new-files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxc-node-importer-failed-"));
  try {
    const lines = Array.from({ length: 600 }, (_, i) => `export const v${i}: number = ${i};`);
    const body = [...lines, "throw new Error('fails');"].join("\n");
    const files = Array.from({ length: 120 }, (_, i) => {
      const file = path.join(dir, `m${i}.ts`);
      fs.writeFileSync(file, body);
      return file;
    });
    const cached = createImporter(path.join(dir, "host.mjs"));
    const collect = () => globalThis.gc({ type: "major", execution: "sync", flavor: "last-resort" });
    const load = (file) => cached.import(file).catch(() => {});
    for (const file of files.slice(0, 20)) await load(file);
    collect();
    const before = process.memoryUsage().heapUsed;
    for (const file of files.slice(20)) await load(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    collect();
    const kb = (process.memoryUsage().heapUsed - before) / 100 / 1024;
    return [kb < 2, `${kb.toFixed(1)} KB per file`];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
// The same, with the failure caught inside a runner file: the error never leaves import().
await probe("memory-failed-caught-new-files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxc-node-importer-caught-"));
  try {
    const lines = Array.from({ length: 600 }, (_, i) => `export const v${i}: number = ${i};`);
    const body = [...lines, "throw new Error('fails');"].join("\n");
    const files = Array.from({ length: 120 }, (_, i) => {
      const file = path.join(dir, `m${i}.ts`);
      fs.writeFileSync(file, body);
      return file;
    });
    fs.writeFileSync(
      path.join(dir, "loader.ts"),
      "export async function tryLoad(file: string): Promise<void> {\n" +
        "  try { await import(file); } catch {}\n}\n",
    );
    const { tryLoad } = await createImporter(path.join(dir, "host.mjs")).import("./loader.ts");
    const collect = () => globalThis.gc({ type: "major", execution: "sync", flavor: "last-resort" });
    for (const file of files.slice(0, 20)) await tryLoad(file);
    collect();
    const before = process.memoryUsage().heapUsed;
    for (const file of files.slice(20)) await tryLoad(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    collect();
    const kb = (process.memoryUsage().heapUsed - before) / 100 / 1024;
    return [kb < 2, `${kb.toFixed(1)} KB per file`];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
await probe("no-leak", async () => {
  const cached = Object.keys(Module._cache).filter((key) => key.startsWith(realpathSync(DIR)));
  let plain;
  try {
    await import(pathToFileURL(path.join(DIR, "lazy-enum.ts")).href);
    plain = "transformed";
  } catch (e) {
    plain = e.code;
  }
  const ok =
    cached.length === 0 &&
    Object.keys(req.extensions).join(",") === extensionsBefore &&
    process.sourceMapsEnabled === sourceMapsBefore &&
    plain !== "transformed";
  return [ok, `cache ${cached.length}, plain import ${plain}`];
});

process.exit(0);
