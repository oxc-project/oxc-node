// `@oxc-node/core/importer`: a TypeScript importer for tools, in the shape of jiti v2.
//
// It is a module runner of its own, not a loader: nothing is registered with Node.js.
// Each file is resolved by oxc-node's resolver, transformed by the same transform as the
// load hook plus oxc's module runner transform, and evaluated here with `node:vm`
// against module records this file keeps. Built-ins, dependencies Node.js can run and
// oxc-node's helpers go through Node.js' own `import()` and `require()`.
import { statSync, readFileSync } from "node:fs";
import Module, { createRequire, isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, resolve as resolvePath, sep } from "node:path";
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
// `import()` inside `eval` or `new Function` in a runner file uses Node.js' own loader.
const importModuleDynamically = vm.constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

// `moduleCache: true` shares one module map per process, as jiti shares `require.cache`.
const sharedCache = new Map();
// The source map of each file the runner evaluated last, to map stack traces.
const sourceMaps = new Map();

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
        throw mapStack(error);
      }
      if (opts.default) {
        return namespace?.default ?? namespace;
      }
      return interopDefault ? interop(namespace) : namespace;
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
  }

  /**
   * @returns {{ builtin: string } | { path: string, native?: boolean }}
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
      const path = fileURLToPath(resolved.url);
      if (statSync(path, { throwIfNoEntry: false })?.isFile()) {
        return { path };
      }
    }
    throw notExported(specifier, parentURL, required) ?? notFound(specifier, parentURL, required);
  }

  /** `import` of a resolved target, from `importer` (a record, or `null` at the top). */
  async import(target, importer) {
    if (target.builtin) {
      return import(target.builtin);
    }
    const { path } = target;
    if (target.native || isNative(path)) {
      return import(pathToFileURL(path).href);
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
    if (target.builtin) {
      const exports = requireSelf(target.builtin);
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

  // A module that failed is forgotten, so that the next import tries it again.
  fail(record, error) {
    if (this.cache.get(record.path) === record) {
      this.cache.delete(record.path);
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
      sourceMaps.set(record.path, { mappings: JSON.parse(output.map).mappings, lines: undefined });
    }
    return output;
  }

  /** Runs an ES module; `sync` code has no `await` on its imports and runs at once. */
  runModule(record, code, sync) {
    const { path, url, namespace } = record;
    const run = compile(
      path,
      `(${sync ? "" : "async "}function (__vite_ssr_exports__, __vite_ssr_import_meta__, ` +
        `__vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__) {'use strict';`,
      code,
    );
    const ssrImport = sync
      ? (specifier) =>
          this.require(this.resolve(specifier, url, this.conditions, false), record, true)
      : (specifier) => this.import(this.resolve(specifier, url, this.conditions, false), record);
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
    return run.call(
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
    require.resolve = (specifier) => {
      const target = resolve(specifier);
      return target.builtin ?? target.path;
    };
    require.cache = Module._cache;
    require.extensions = Module._extensions;
    return require;
  }

  dynamicImport(record) {
    return async (specifier) =>
      this.import(this.resolve(String(specifier), record.url, this.conditions, false), record);
  }

  importMeta(record) {
    const { path, url } = record;
    return {
      url,
      filename: path,
      dirname: dirname(path),
      resolve: (specifier, parent) => {
        try {
          return urlOf(
            this.resolve(specifier, parent ? String(parent) : url, this.conditions, false),
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

function compile(path, head, code) {
  const sourceMap = sourceMaps.get(path);
  if (sourceMap) {
    // The function head shares the first line with the code.
    sourceMap.head = head.length;
  }
  return vm.runInThisContext(`${head}${code}\n})`, { filename: path, importModuleDynamically });
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

function addNamedExports(namespace, exports) {
  if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) {
    return;
  }
  for (const key of Object.keys(exports)) {
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
function mapStack(error) {
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
    const position = sourcePosition(file, Number(line) - 1, Number(column) - 1);
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

function sourcePosition(file, line, column) {
  const sourceMap = sourceMaps.get(file);
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

function urlOf(target) {
  if (target.builtin) {
    return target.builtin.startsWith("node:") ? target.builtin : `node:${target.builtin}`;
  }
  return pathToFileURL(target.path).href;
}

// What `try: true` turns into `undefined`: a module that is not there, or a path its
// package does not export, as jiti does.
function isNotFound(error) {
  return (
    error?.code === "ERR_MODULE_NOT_FOUND" ||
    error?.code === "MODULE_NOT_FOUND" ||
    error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
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
  const url =
    isPath(specifier) && parentURL.startsWith("file:") ? new URL(specifier, parentURL) : undefined;
  const shown = url?.protocol === "file:" ? fileURLToPath(url) : specifier;
  const error = new Error(`Cannot find module '${shown}' imported from ${parent}`);
  error.code = "ERR_MODULE_NOT_FOUND";
  if (url) {
    error.url = url.href;
  }
  return error;
}

// oxc's resolver only says that it found nothing. When a package's `exports` leaves the
// path out, Node.js' resolver says so, and its error is the one to throw.
function notExported(specifier, parentURL, required) {
  if (isPath(specifier) || specifier.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(specifier)) {
    return undefined;
  }
  try {
    createRequire(pathOf(fileParent(parentURL))).resolve(specifier);
  } catch (cause) {
    if (cause?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      const from = required ? "" : ` imported from ${pathOf(parentURL)}`;
      const error = new Error(`${cause.message}${from}`);
      error.code = cause.code;
      return error;
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

function requireAsyncModule(path, importer) {
  const from = importer ? `\n  From ${importer.path} ` : "\n  ";
  const error = new Error(`${REQUIRE_ASYNC_MODULE_MESSAGE}${from}Requiring ${path}`);
  error.code = "ERR_REQUIRE_ASYNC_MODULE";
  return error;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
