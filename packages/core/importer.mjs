// `@oxc-node/core/importer`: a TypeScript importer for tools, in the shape of jiti v2.
//
// It is a module runner of its own, not a loader: nothing is registered with Node.js.
// Each file is resolved by oxc-node's resolver, transformed by the same transform as the
// load hook plus oxc's module runner transform, and evaluated here with `node:vm`
// against module records this file keeps. Built-ins, dependencies Node.js can run and
// oxc-node's helpers go through Node.js' own `import()` and `require()`.
import { statSync, readFileSync } from "node:fs";
import Module, { createRequire, isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import vm from "node:vm";

import { createResolve, transformModuleRunner, transformsDep } from "./index.js";

const IMPORT_CONDITIONS = ["node", "import"];
const REQUIRE_CONDITIONS = ["node", "require"];
// Files the runner transforms and evaluates; anything else goes to Node.js.
const RUN_EXTENSIONS = new Set(["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
// Node.js cannot run these from `node_modules`, so the runner always does.
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".jsx"]);
const NODE_MODULES = `${sep}node_modules${sep}`;
// The transform emits `@oxc-node/core/helpers/*` imports, which belong to this copy.
const HELPER_PREFIX = "@oxc-node/core/helpers/";
const REQUIRE_ASYNC_MODULE_MESSAGE =
  "require() cannot be used on an ESM graph with top-level await. Use import() instead.";

const RESOLVE_OPTIONS = { getCurrentDirectory: () => process.cwd() };

const requireSelf = createRequire(import.meta.url);
const HAS_IMPORT_META_MAIN = "main" in import.meta;
// `import()` inside `eval` or `new Function` in a runner file uses Node.js' own loader.
const importModuleDynamically = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

// `moduleCache: true` shares one module map per process, as jiti shares `require.cache`.
const sharedCache = new Map();
// Per module map: the source map of each file it ran, to map stack traces. They go
// with the module map, so a `moduleCache: false` graph takes its maps along when it goes.
const sourceMapsOfCache = new WeakMap();
// The source maps of the modules an error failed, by error.
const failedSourceMaps = new WeakMap();

/**
 * @param {string | URL} parentId
 * @param {{ moduleCache?: boolean, interopDefault?: boolean }} [options]
 */
export function createImporter(parentId, options = {}) {
  const parentURL = toParentURL(parentId);
  const moduleCache = options.moduleCache !== false;
  const interopDefault = options.interopDefault !== false;
  const graph = (conditions) =>
    new Graph(moduleCache ? sharedCache : new Map(), conditions ?? IMPORT_CONDITIONS);
  const parentOf = (opts) => (opts.parentURL ? toParentURL(opts.parentURL) : parentURL);

  return {
    async import(id, opts = {}) {
      const runner = graph(opts.conditions);
      let target;
      try {
        target = runner.resolve(specifierOf(id), parentOf(opts), runner.conditions, false);
      } catch (error) {
        if (opts.try && isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
      let namespace;
      try {
        namespace = await runner.import(target, null);
      } catch (error) {
        throw mapStack(error, runner.sourceMaps);
      }
      // As jiti: `default` is read through the interop, when it is on.
      const result = interopDefault ? interop(namespace) : namespace;
      return opts.default ? (result?.default ?? result) : result;
    },

    resolve(id, opts = {}) {
      const runner = graph(opts.conditions);
      try {
        return urlOf(runner.resolve(specifierOf(id), parentOf(opts), runner.conditions, false));
      } catch (error) {
        if (opts.try && isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

/** One module graph: the module map it fills and the conditions it resolves with. */
class Graph {
  constructor(cache, conditions) {
    this.cache = cache;
    this.conditions = conditions;
    let sourceMaps = sourceMapsOfCache.get(cache);
    if (!sourceMaps) {
      sourceMaps = new Map();
      sourceMapsOfCache.set(cache, sourceMaps);
    }
    this.sourceMaps = sourceMaps;
  }

  /**
   * @returns {{ builtin: string } | { url: string } | { path: string, native?: boolean }}
   */
  resolve(specifier, parentURL, conditions, required) {
    if (isBuiltin(specifier)) {
      return { builtin: specifier };
    }
    if (specifier.startsWith(HELPER_PREFIX)) {
      return { path: requireSelf.resolve(specifier), native: true };
    }
    const resolved = createResolve(
      // Only the WASI build reads it: it has no working directory of its own.
      RESOLVE_OPTIONS,
      specifier,
      { conditions, importAttributes: {}, parentURL: fileParent(parentURL) },
      // oxc's resolver found nothing: hand the specifier back unresolved.
      (url) => ({ url }),
    );
    if (resolved.format === "builtin") {
      return { builtin: resolved.url };
    }
    if (resolved.url.startsWith("file:")) {
      const path = filePath(resolved.url);
      if (path && statSync(path, { throwIfNoEntry: false })?.isFile()) {
        return { path };
      }
    } else if (/^[a-z][a-z\d+.-]+:/i.test(resolved.url)) {
      // Another URL, such as `data:`, is Node.js' to load or to reject.
      return { url: resolved.url };
    }
    throw notExported(specifier, parentURL, required) ?? notFound(specifier, parentURL, required);
  }

  /**
   * `import` of a resolved target, from `importer` (a record, or `null` at the top).
   * `options`, a dynamic import's second argument, goes to Node.js with what it loads.
   */
  async import(target, importer, options) {
    if (target.builtin || target.url) {
      return import(target.builtin ?? target.url, options);
    }
    const { path } = target;
    if (target.native || isNative(path)) {
      return import(pathToFileURL(path).href, options);
    }
    let record = this.cache.get(path);
    if (record) {
      if (!record.done) {
        // A module importing one that waits on it, directly or not, is a cycle: it gets
        // the namespace as far as it is filled, as an ES module would.
        if (importer && (record === importer || waitsOn(record, importer))) {
          return record.namespace;
        }
        await waitFor(importer, record);
      }
      return record.namespace;
    }
    record = this.create(path);
    importer?.waitingOn.add(record);
    try {
      await this.evaluate(record);
      this.settle(record);
    } catch (error) {
      this.fail(record, error);
      throw error;
    } finally {
      importer?.waitingOn.delete(record);
    }
    return record.namespace;
  }

  /**
   * `require()` of a resolved target, or a static import of an ES module that is being
   * `require()`d (`esm`), which wants a namespace back.
   */
  require(target, importer, esm) {
    if (target.builtin || target.url) {
      const exports = requireSelf(target.builtin ?? target.url);
      return esm ? namespaceOf(exports) : exports;
    }
    const { path } = target;
    if (target.native || isNative(path)) {
      const exports = requireSelf(path);
      return esm && !types.isModuleNamespaceObject(exports) ? namespaceOf(exports) : exports;
    }
    let record = this.cache.get(path);
    if (!record) {
      record = this.create(path);
      try {
        this.evaluateSync(record, importer);
        this.settle(record);
      } catch (error) {
        this.fail(record, error);
        throw error;
      }
    } else if (record.async) {
      // An ES module with top-level await in its graph, loaded by `import()` before.
      throw requireAsyncModule(path, importer);
    }
    // A record that is still loading is a cycle: it is handed over as far as it got.
    if (esm || record.kind === "esm") {
      return record.namespace;
    }
    return record.kind === "data" ? record.namespace.default : record.module.exports;
  }

  create(path) {
    const record = {
      path,
      url: pathToFileURL(path).href,
      kind: "esm",
      namespace: makeNamespace(),
      module: undefined,
      done: false,
      // The module or one it imports statically awaits at its top level.
      async: false,
      waitingOn: new Set(),
      ...Promise.withResolvers(),
    };
    // A failure is reported to whoever imported the module; waiters see it on their own.
    record.promise.catch(() => {});
    this.cache.set(path, record);
    return record;
  }

  settle(record) {
    record.done = true;
    record.resolve();
  }

  // A module that failed is forgotten, so that the next import tries it again. Its
  // source map goes with the error, for its stack, and is gone when the error is.
  fail(record, error) {
    if (this.cache.get(record.path) === record) {
      this.cache.delete(record.path);
      const sourceMap = this.sourceMaps.get(record.path);
      this.sourceMaps.delete(record.path);
      if (
        sourceMap &&
        error !== null &&
        (typeof error === "object" || typeof error === "function")
      ) {
        let maps = failedSourceMaps.get(error);
        if (!maps) {
          maps = new Map();
          failedSourceMaps.set(error, maps);
        }
        maps.set(record.path, sourceMap);
      }
    }
    record.reject(error);
  }

  async evaluate(record) {
    if (this.evaluateData(record)) {
      return;
    }
    const output = this.transform(record, false);
    if (!output.esm) {
      this.runCommonJs(record, output.code);
      return;
    }
    record.async = output.topLevelAwait;
    await this.runModule(record, output.code, false);
  }

  evaluateSync(record, importer) {
    if (this.evaluateData(record)) {
      return;
    }
    const output = this.transform(record, true);
    if (!output.esm) {
      this.runCommonJs(record, output.code);
      return;
    }
    if (output.topLevelAwait) {
      throw requireAsyncModule(record.path, importer);
    }
    this.runModule(record, output.code, true);
  }

  // JSON and native addons, which are no code to transform.
  evaluateData(record) {
    const extension = extname(record.path);
    if (extension === ".json") {
      record.kind = "data";
      const value = JSON.parse(stripBom(readFileSync(record.path, "utf8")));
      record.namespace.default = value;
      // Named exports per key, as the load hook gives a JSON module imported without
      // an attribute.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of Object.keys(value)) {
          if (key !== "default") {
            record.namespace[key] = value[key];
          }
        }
      }
      return true;
    }
    if (extension === ".node") {
      record.kind = "data";
      record.namespace.default = requireSelf(record.path);
      return true;
    }
    return false;
  }

  transform(record, sync) {
    const output = transformModuleRunner(record.path, readFileSync(record.path), sync);
    if (output.map) {
      this.sourceMaps.set(record.path, {
        mappings: JSON.parse(output.map).mappings,
        lines: undefined,
      });
    }
    return output;
  }

  /** Runs an ES module; `sync` code has no `await` on its imports and runs at once. */
  runModule(record, code, sync) {
    const { path, url, namespace } = record;
    // `__filename`, `__dirname` and `require` are there for ES modules too, as jiti has
    // them, for configs such as `path.resolve(__dirname, "src")`. They come from an outer
    // function, so that a module declaring its own (`const require = createRequire(...)`)
    // shadows them instead of failing as a redeclaration.
    const run = compile(
      path,
      "(function (__filename, __dirname, require) { return " +
        `${sync ? "" : "async "}function (__vite_ssr_exports__, __vite_ssr_import_meta__, ` +
        `__vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__) {'use strict';`,
      code,
      this.sourceMaps.get(path),
      "\n}})",
    );
    const ssrImport = sync
      ? (specifier) => {
          const target = this.resolve(specifier, url, this.conditions, false);
          return this.interop(target, this.require(target, record, true));
        }
      : async (specifier) => {
          const target = this.resolve(specifier, url, this.conditions, false);
          // A module that statically imports one with top-level await is async too.
          // The record exists, and knows about its own await, once the import starts: it
          // is marked before the wait, so that a `require()` of this module meanwhile
          // fails as well.
          const importing = this.import(target, record);
          const dependency = target.path && this.cache.get(target.path);
          if (dependency?.async) {
            record.async = true;
          }
          const imported = await importing;
          // A module Node.js loads tells only once it is loaded, and a record may have
          // learned of an await further down while it ran.
          if (dependency ? dependency.async : target.path && isAsyncModule(target.path)) {
            record.async = true;
          }
          return this.interop(target, imported);
        };
    // Local exports are defined first and win. A name two sources give different
    // values is left out, as Node.js leaves out a name two modules export as different
    // bindings; the same binding reached twice gives the same value and stays.
    const starred = new Set();
    const ambiguous = new Set();
    const exportAll = (source) => {
      for (const key in source) {
        if (key === "default" || ambiguous.has(key)) {
          continue;
        }
        if (starred.has(key)) {
          if (!sameValue(namespace, source, key)) {
            ambiguous.add(key);
            delete namespace[key];
          }
        } else if (!(key in namespace)) {
          starred.add(key);
          Object.defineProperty(namespace, key, {
            enumerable: true,
            configurable: true,
            get: () => source[key],
          });
        }
      }
    };
    return run(path, dirname(path), this.makeRequire(record)).call(
      undefined,
      namespace,
      this.importMeta(record),
      ssrImport,
      this.dynamicImport(record),
      exportAll,
    );
  }

  runCommonJs(record, code) {
    const { path } = record;
    // Never put in `Module._cache`: the file belongs to this runner only.
    const module = new Module(path, null);
    module.filename = path;
    module.paths = Module._nodeModulePaths(dirname(path));
    const require = this.makeRequire(record);
    module.require = require;
    record.kind = "cjs";
    record.module = module;
    Object.defineProperty(record.namespace, "default", {
      enumerable: true,
      get: () => module.exports,
    });
    const run = compile(
      path,
      "(function (exports, require, module, __filename, __dirname, " +
        "__vite_ssr_import_meta__, __vite_ssr_dynamic_import__) {",
      code,
      this.sourceMaps.get(path),
    );
    run.call(
      module.exports,
      module.exports,
      require,
      module,
      path,
      dirname(path),
      this.importMeta(record),
      this.dynamicImport(record),
    );
    module.loaded = true;
    addNamedExports(record.namespace, module.exports);
  }

  makeRequire(record) {
    const resolve = (specifier) => this.resolve(specifier, record.url, REQUIRE_CONDITIONS, true);
    const require = (specifier) => this.require(resolve(specifier), record, false);
    require.resolve = (specifier, options) => {
      // Folders to look in instead of the file's own are Node.js' lookup, as in jiti.
      if (options?.paths) {
        return createRequire(record.path).resolve(specifier, options);
      }
      const target = resolve(specifier);
      return target.builtin ?? target.url ?? target.path;
    };
    // The folders Node.js would look in, which no resolver of ours changes.
    require.resolve.paths = (request) => createRequire(record.path).resolve.paths(request);
    require.cache = Module._cache;
    require.extensions = Module._extensions;
    require.main = requireSelf.main;
    return require;
  }

  dynamicImport(record) {
    return async (specifier, options) => {
      const target = this.resolve(String(specifier), record.url, this.conditions, false);
      return this.interop(target, await this.import(target, record, options));
    };
  }

  /**
   * What an import inside a runner file sees of a CommonJS module: Babel's and tsc's
   * output marks itself with `__esModule`, and its default export is then
   * `exports.default`, as in jiti's transformed files (and Babel's and Vite's). The
   * module `importer.import()` returns stays as Node.js gives it, as in jiti.
   */
  interop(target, namespace) {
    if (!target.path) {
      return namespace;
    }
    const record = this.cache.get(target.path);
    if (record) {
      return record.kind === "cjs" ? esModuleInterop(namespace) : namespace;
    }
    // Node.js loaded it: CommonJS sits in `require.cache` with its own exports, an ES
    // module is not there, or holds its namespace there after a `require()`.
    const cached = Module._cache[target.path];
    return cached && !types.isModuleNamespaceObject(cached.exports)
      ? esModuleInterop(namespace)
      : namespace;
  }

  importMeta(record) {
    const { path, url } = record;
    return {
      // An imported module is never the entry, where Node.js has `main`.
      ...(HAS_IMPORT_META_MAIN && { main: false }),
      url,
      filename: path,
      dirname: dirname(path),
      resolve: (specifier, parent) => {
        try {
          return urlOf(
            this.resolve(String(specifier), parent ? String(parent) : url, this.conditions, false),
          );
        } catch (error) {
          // As Node.js does: a path that names no file still has a URL.
          if (error?.code === "ERR_MODULE_NOT_FOUND" && error.url) {
            return error.url;
          }
          throw error;
        }
      },
    };
  }
}

function compile(path, head, code, sourceMap, tail = "\n})") {
  if (sourceMap) {
    // The function head shares the first line with the code.
    sourceMap.head = head.length;
  }
  return vm.runInThisContext(`${head}${code}${tail}`, { filename: path, importModuleDynamically });
}

// Dependencies Node.js runs itself: a JavaScript file in `node_modules` the transform
// mode leaves alone, and every file that is no source code.
function isNative(path) {
  const extension = extname(path);
  if (extension === ".json" || extension === ".node") {
    return false;
  }
  if (!RUN_EXTENSIONS.has(extension)) {
    return true;
  }
  return path.includes(NODE_MODULES) && !TS_EXTENSIONS.has(extension) && !transformsDep(path);
}

// Whether two `export *` sources give `key` the same value; a name that cannot be read
// yet, in a cycle, keeps the first source.
function sameValue(namespace, source, key) {
  try {
    return Object.is(namespace[key], source[key]);
  } catch {
    return true;
  }
}

function waitsOn(record, target, seen = new Set()) {
  for (const next of record.waitingOn) {
    if (next === target) {
      return true;
    }
    if (!seen.has(next)) {
      seen.add(next);
      if (waitsOn(next, target, seen)) {
        return true;
      }
    }
  }
  return false;
}

async function waitFor(importer, record) {
  importer?.waitingOn.add(record);
  try {
    await record.promise;
  } finally {
    importer?.waitingOn.delete(record);
  }
}

function makeNamespace() {
  const namespace = Object.create(null);
  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
  return namespace;
}

// What `import` of a CommonJS module gives: `default` is `module.exports`, plus a named
// export for each of its keys.
function namespaceOf(exports) {
  const namespace = makeNamespace();
  namespace.default = exports;
  addNamedExports(namespace, exports);
  return namespace;
}

// `exports.default` for CommonJS output that says it was an ES module (`__esModule`),
// else `module.exports`.
function commonJsDefault(exports) {
  return exports !== null &&
    (typeof exports === "object" || typeof exports === "function") &&
    exports.__esModule
    ? exports.default
    : exports;
}

// The namespace of a CommonJS module, whose default is `module.exports`, with
// `commonJsDefault` as its default.
const interopNamespaces = new WeakMap();
function esModuleInterop(namespace) {
  const exports = namespace.default;
  if (commonJsDefault(exports) === exports) {
    return namespace;
  }
  let wrapped = interopNamespaces.get(namespace);
  if (!wrapped) {
    wrapped = makeNamespace();
    Object.defineProperty(wrapped, "default", {
      enumerable: true,
      get: () => commonJsDefault(exports),
    });
    addNamedExports(wrapped, namespace);
    interopNamespaces.set(namespace, wrapped);
  }
  return wrapped;
}

function addNamedExports(namespace, exports) {
  if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) {
    return;
  }
  // On an exports object, hidden properties count too, such as
  // `Object.defineProperty(exports, "a", { value })` and Babel's `__esModule`, as
  // Node.js' CommonJS import finds them. A function's or an array's do not: those are
  // `length`, `prototype` or a class's static methods.
  const plain = typeof exports === "object" && !Array.isArray(exports);
  const keys = plain ? Object.getOwnPropertyNames(exports) : Object.keys(exports);
  if (!plain && exports.__esModule && !keys.includes("__esModule")) {
    keys.push("__esModule");
  }
  for (const key of keys) {
    if (key !== "default" && !(key in namespace)) {
      Object.defineProperty(namespace, key, { enumerable: true, get: () => exports[key] });
    }
  }
}

// jiti's `interopDefault`: the namespace, with `default`'s properties readable from it.
const interopProxies = new WeakMap();
function interop(namespace) {
  if (namespace === null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    return namespace;
  }
  const value = namespace.default;
  const valueIsObject =
    value !== null && (typeof value === "object" || typeof value === "function");
  if (value == null && namespace instanceof Promise) {
    return namespace;
  }
  let proxy = interopProxies.get(namespace);
  if (proxy) {
    return proxy;
  }
  const bound = new Map();
  proxy = new Proxy(namespace, {
    get(target, key) {
      if (key === "__esModule") {
        return true;
      }
      if (key === "default") {
        if (value == null) {
          return namespace;
        }
        return typeof value?.default === "function" && namespace.__esModule ? value.default : value;
      }
      if (key in target) {
        return target[key];
      }
      if (valueIsObject && !(value instanceof Promise)) {
        const fallback = value[key];
        if (typeof fallback !== "function") {
          return fallback;
        }
        if (bound.get(key)?.source !== fallback) {
          bound.set(key, { source: fallback, bound: fallback.bind(value) });
        }
        return bound.get(key).bound;
      }
      return undefined;
    },
  });
  interopProxies.set(namespace, proxy);
  return proxy;
}

// ---------- stack traces ----------

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64 = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64_DIGITS.length; index++) {
  BASE64[BASE64_DIGITS.charCodeAt(index)] = index;
}

/** A source map's `mappings`, as `[generatedColumn, sourceLine, sourceColumn]` per line. */
function decodeMappings(mappings) {
  const lines = [[]];
  const segment = [];
  let column = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (segment.length > 0) {
      column += segment[0];
      if (segment.length >= 4) {
        sourceLine += segment[2];
        sourceColumn += segment[3];
        lines[lines.length - 1].push([column, sourceLine, sourceColumn]);
      }
      segment.length = 0;
    }
  };
  for (let index = 0; index < mappings.length; index++) {
    const char = mappings.charCodeAt(index);
    if (char === 59 /* ; */) {
      flush();
      lines.push([]);
      column = 0;
    } else if (char === 44 /* , */) {
      flush();
    } else {
      const digit = BASE64[char] ?? -1;
      if (digit === -1) {
        break;
      }
      value += (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
      } else {
        segment.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
  }
  flush();
  return lines;
}

// `    at name (/path/file.ts:3:7)` and `    at /path/file.ts:3:7`.
const STACK_FRAME = /^(\s+at (?:.*? \()?)(.+):(\d+):(\d+)(\)?)$/gm;
const mappedErrors = new WeakSet();

/**
 * Points the stack frames of runner files at their source, with the source maps of the
 * transform. Only errors that leave `import()` get this: no global hook is installed.
 */
function mapStack(error, sourceMaps) {
  if (error === null || typeof error !== "object" || mappedErrors.has(error)) {
    return error;
  }
  mappedErrors.add(error);
  let stack;
  try {
    stack = error.stack;
  } catch {
    return error;
  }
  if (typeof stack !== "string") {
    return error;
  }
  const mapped = stack.replace(STACK_FRAME, (frame, head, file, line, column, tail) => {
    const sourceMap = failedSourceMaps.get(error)?.get(file) ?? sourceMaps.get(file);
    const position = sourcePosition(sourceMap, Number(line) - 1, Number(column) - 1);
    return position ? `${head}${file}:${position[0] + 1}:${position[1] + 1}${tail}` : frame;
  });
  if (mapped !== stack) {
    try {
      error.stack = mapped;
    } catch {
      // A frozen error keeps its stack.
    }
  }
  return error;
}

function sourcePosition(sourceMap, line, column) {
  if (!sourceMap) {
    return undefined;
  }
  sourceMap.lines ??= decodeMappings(sourceMap.mappings);
  const segments = sourceMap.lines[line];
  const generated = line === 0 ? column - (sourceMap.head ?? 0) : column;
  let found;
  for (const segment of segments ?? []) {
    if (segment[0] > generated) {
      break;
    }
    found = segment;
  }
  return found && [found[1], found[2]];
}

// ---------- small helpers ----------

function toParentURL(parent) {
  if (parent instanceof URL) {
    return parent.href;
  }
  if (typeof parent !== "string" || parent === "") {
    return pathToFileURL(process.cwd() + sep).href;
  }
  if (parent.startsWith("file:")) {
    return parent;
  }
  const url = pathToFileURL(resolvePath(parent)).href;
  // A trailing separator names a directory to resolve from.
  return /[/\\]$/.test(parent) && !url.endsWith("/") ? `${url}/` : url;
}

// A directory parent resolves as a file in it would, so that its own `tsconfig.json`
// applies, as Node.js' `createRequire()` does with `noop.js`.
function fileParent(parentURL) {
  if (!parentURL.startsWith("file:")) {
    return parentURL;
  }
  const url = new URL(parentURL);
  if (!url.pathname.endsWith("/")) {
    return parentURL;
  }
  url.pathname += "noop.js";
  url.search = "";
  url.hash = "";
  return url.href;
}

function specifierOf(id) {
  if (id instanceof URL) {
    return id.href;
  }
  // An absolute Windows path is no URL: resolve it as a file.
  return isAbsolute(id) && !id.startsWith("/") ? pathToFileURL(id).href : id;
}

// The path of a `file:` URL, or `undefined` for one that has none here, such as
// `file:///a` on Windows, without a drive.
function filePath(url) {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function urlOf(target) {
  if (target.url) {
    return target.url;
  }
  if (target.builtin) {
    return target.builtin.startsWith("node:") ? target.builtin : `node:${target.builtin}`;
  }
  return pathToFileURL(target.path).href;
}

// What `try: true` turns into `undefined`: a module that is not there, a path its
// package does not export, or a `#` alias its package does not define, as jiti does.
function isNotFound(error) {
  return (
    error?.code === "ERR_MODULE_NOT_FOUND" ||
    error?.code === "MODULE_NOT_FOUND" ||
    error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    error?.code === "ERR_PACKAGE_IMPORT_NOT_DEFINED"
  );
}

function notFound(specifier, parentURL, required) {
  const parent = pathOf(parentURL);
  if (required) {
    const error = new Error(`Cannot find module '${specifier}'\nRequire stack:\n- ${parent}`);
    error.code = "MODULE_NOT_FOUND";
    return error;
  }
  // A path is shown resolved, and its URL is kept on the error, as Node.js keeps it.
  const url = specifier.startsWith("file:")
    ? new URL(specifier)
    : isPath(specifier) && parentURL.startsWith("file:")
      ? new URL(specifier, parentURL)
      : undefined;
  const shown = (url?.protocol === "file:" && filePath(url)) || specifier;
  const error = new Error(`Cannot find module '${shown}' imported from ${parent}`);
  error.code = "ERR_MODULE_NOT_FOUND";
  if (url) {
    error.url = url.href;
  }
  return error;
}

// oxc's resolver only says that it found nothing. When a package's `exports` leaves the
// path out, or its `imports` has no `#` alias, Node.js' resolver says so, and its error is
// the one to throw.
function notExported(specifier, parentURL, required) {
  if (isPath(specifier) || /^[a-z][a-z\d+.-]*:/i.test(specifier)) {
    return undefined;
  }
  const from = required ? "" : ` imported from ${pathOf(parentURL)}`;
  let found;
  try {
    found = createRequire(pathOf(fileParent(parentURL))).resolve(specifier);
  } catch (cause) {
    // Node.js' message names the importing file already.
    if (cause?.code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") {
      const error = new Error(cause.message);
      error.code = cause.code;
      return error;
    }
    if (cause?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      const error = new Error(`${cause.message}${from}`);
      error.code = cause.code;
      return error;
    }
    return undefined;
  }
  // Node.js' `require` conditions find the path, the conditions in use do not: the
  // package exports it only under other conditions.
  if (required || specifier.startsWith("#")) {
    return undefined;
  }
  const name = specifier.split("/", specifier.startsWith("@") ? 2 : 1).join("/");
  const packageJson = exportingPackageJson(found, name);
  if (!packageJson) {
    return undefined;
  }
  const subpath = `.${specifier.slice(name.length)}`;
  const error = new Error(
    subpath === "."
      ? `No "exports" main defined in ${packageJson}${from}`
      : `Package subpath '${subpath}' is not defined by "exports" in ${packageJson}${from}`,
  );
  error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
  return error;
}

// The `package.json` of package `name` above `file`, when it has `exports`.
function exportingPackageJson(file, name) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const packageJson = join(dir, "package.json");
    let json;
    try {
      json = JSON.parse(readFileSync(packageJson, "utf8"));
    } catch {
      continue;
    }
    // A nested `package.json`, such as one that only sets `type`, is not the package's.
    if (json.name === name) {
      return json.exports === undefined ? undefined : packageJson;
    }
  }
  return undefined;
}

function isPath(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function pathOf(url) {
  return url.startsWith("file:") ? fileURLToPath(url) : url;
}

// Whether a module Node.js loaded has top-level await in its graph. It is loaded
// already, so `require()` only looks it up, and Node.js tells.
function isAsyncModule(path) {
  try {
    requireSelf(path);
    return false;
  } catch (error) {
    return error?.code === "ERR_REQUIRE_ASYNC_MODULE";
  }
}

function requireAsyncModule(path, importer) {
  const from = importer ? `\n  From ${importer.path} ` : "\n  ";
  const error = new Error(`${REQUIRE_ASYNC_MODULE_MESSAGE}${from}Requiring ${path}`);
  error.code = "ERR_REQUIRE_ASYNC_MODULE";
  return error;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
