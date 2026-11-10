import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import * as NodeModule from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

import { addHook } from "pirates";

import {
  OxcTransformer,
  createResolve,
  enableWatchReport,
  freezeTsconfig,
  freezeTransformDeps,
  initTracing,
  load as oxcLoad,
  takeWatchDependencies,
  transformsDep,
  tsconfigPathCandidates,
} from "./index.js";
import { installSignalAck } from "./signal-ack.mjs";
import { createRelay, flush, watchSink, withFlush } from "./watch-report.mjs";

// A no-op unless oxnode set OXNODE_SIGNAL_ACK for this process.
if (isMainThread) {
  installSignalAck();
}

// Where to report the files a watch parent should restart on, or `null` when
// nobody is watching. Turned on before the first transform or resolve, which
// is when tsconfig files are read.
const watch = watchSink();
if (watch) {
  enableWatchReport();
}

// Destructure from NodeModule namespace to support older Node.js versions
const { Module, createRequire, register, registerHooks, setSourceMapsSupport } = NodeModule;
const isBuiltin =
  NodeModule.isBuiltin ??
  ((request) => NodeModule.builtinModules.includes(request.replace(/^node:/, "")));

const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
  ".es6",
  ".es",
]);

// The transformer emits `@oxc-node/core/helpers/<name>` specifiers for its runtime
// helpers. They are versioned with this package and must resolve against the copy
// whose transformer emitted them — a user file is not expected to have
// `@oxc-node/core` in scope at all (global install, `node --import`). Two copies can
// also be registered in one process (`NODE_OPTIONS` preloading one while a global
// `oxnode` adds another), so each copy tags the module name it passes to the
// transformer and registers a resolver for that tag: a tagged specifier only ever
// resolves against the copy that emitted it.
const HELPER_SPECIFIER_PREFIX = "@oxc-node/core/helpers/";
const HELPER_TAGGED_PREFIX = "@oxc-node/core@";
/**
 * The tag of the module at `url`, as `esm.mjs` computes its own.
 *
 * @param {string} url
 * @returns {string}
 */
function helperTag(url) {
  return "c" + createHash("sha256").update(url).digest("hex").slice(0, 12);
}

const HELPER_TAG = helperTag(import.meta.url);
const HELPER_MODULE_NAME = `${HELPER_TAGGED_PREFIX}${HELPER_TAG}`;

const requireHelper = createRequire(import.meta.url);
const resolveHelper = (subpath) => requireHelper.resolve(`@oxc-node/core/${subpath}`);

// Each copy's resolver lives in a realm-wide registry keyed by its tag. Tagged
// specifiers take exactly their owner's resolver; untagged ones — emitted by older
// published copies that know nothing of tagging — try every registered resolver,
// newest registration first.
const HELPER_RESOLVERS = Symbol.for("@oxc-node/core:helperResolvers");
const helperResolvers = (globalThis[HELPER_RESOLVERS] ??= {});
helperResolvers[HELPER_TAG] = resolveHelper;

function isHelperSpecifier(specifier) {
  return (
    specifier.startsWith(HELPER_SPECIFIER_PREFIX) || specifier.startsWith(HELPER_TAGGED_PREFIX)
  );
}

function resolveHelperPath(specifier) {
  if (specifier.startsWith(HELPER_TAGGED_PREFIX)) {
    const helperIndex = specifier.indexOf("/helpers/");
    if (helperIndex === -1) {
      return undefined;
    }
    const tag = specifier.slice(HELPER_TAGGED_PREFIX.length, helperIndex);
    const subpath = specifier.slice(helperIndex + 1); // "helpers/<name>"
    return helperResolvers[tag]?.(subpath);
  }
  const subpath = specifier.slice("@oxc-node/core/".length); // "helpers/<name>"
  const resolvers = Object.values(helperResolvers).reverse();
  for (const resolve of resolvers) {
    try {
      return resolve(subpath);
    } catch {
      // That copy does not export this helper; the next one might.
    }
  }
  return undefined;
}

// `require()` never reaches `module.register()`'s hooks, and `registerHooks()`
// forwards it to Node.js' own CommonJS resolution, which funnels through
// `Module._resolveFilename` — patching it is the one mechanism that covers every
// supported runtime.
const resolveFilename = Module._resolveFilename;
// Resolving a helper re-enters `Module._resolveFilename`, so an in-flight flag lets
// that inner call fall through to the original resolver. The flag is shared
// process-wide via `Symbol.for`: with several copies registered, each one wraps the
// previous function, and the inner call has to pass them all.
const HELPER_RESOLVING = Symbol.for("@oxc-node/core:resolvingHelper");
Module._resolveFilename = function oxcResolveFilename(request, parent, isMain, options) {
  if (!globalThis[HELPER_RESOLVING] && isHelperSpecifier(request)) {
    if (request.startsWith(HELPER_TAGGED_PREFIX)) {
      globalThis[HELPER_RESOLVING] = true;
      try {
        const resolved = resolveHelperPath(request);
        if (resolved !== undefined) {
          return resolved;
        }
        // The tagged copy is not registered here — fall through to Node.js' own
        // resolution so the request fails (or succeeds) as it would have before
        // the patch.
      } finally {
        globalThis[HELPER_RESOLVING] = false;
      }
    } else {
      // An untagged specifier was emitted by an older copy, which cannot be named,
      // or by the public `transform` API running inside a user project — so the
      // project-scoped resolution a `require` would normally do goes first, and
      // registered copies supply it only when the project itself cannot.
      try {
        return resolveFilename.call(this, request, parent, isMain, options);
      } catch (error) {
        globalThis[HELPER_RESOLVING] = true;
        try {
          const resolved = resolveHelperPath(request);
          if (resolved !== undefined) {
            return resolved;
          }
        } finally {
          globalThis[HELPER_RESOLVING] = false;
        }
        throw error;
      }
    }
  }
  // Node.js' CommonJS resolution knows nothing of tsconfig `paths` and `baseUrl`. The
  // ES module resolver, `tsc` and tsx try them before `node_modules`, so a bare
  // request does here too: an ES module compiled to CommonJS finds what it imported as
  // an ES module (#905). Each file an alias maps to resolves through this function, so
  // the rules below apply to it as well.
  if (mapsThroughTsconfig(request, parent)) {
    const candidates = tsconfigPathCandidates(process.cwd(), parent.filename, request);
    // Finding the importer's tsconfig reads it.
    if (watch) {
      flush(watch, takeWatchDependencies);
    }
    for (const candidate of candidates) {
      try {
        return oxcResolveFilename.call(this, candidate, parent, isMain, options);
      } catch (error) {
        // The next candidate, then the request itself, may still resolve.
        if (error?.code !== "MODULE_NOT_FOUND") {
          throw error;
        }
      }
    }
  }
  let resolved;
  try {
    resolved = resolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    // A TypeScript file is imported by its output's name — `./lib.js` for `lib.ts`,
    // `./lib.mjs` for `lib.mts` — and an ES module compiled to CommonJS keeps that
    // name in its `require()`. Node.js' CommonJS resolution knows only the output, so
    // when it is missing the source is tried instead, as the ES module resolver does.
    if (error?.code === "MODULE_NOT_FOUND") {
      for (const candidate of sourcesFor(request, MISSING_OUTPUT_SOURCES)) {
        try {
          return resolveFilename.call(this, candidate, parent, isMain, options);
        } catch {
          // Not this one either; the original error is the one to report.
        }
      }
    }
    throw error;
  }
  // A TypeScript importer resolves TypeScript first, as the ES module resolver does for
  // it (#840), where Node.js' CommonJS resolution finds another file first: the output
  // beside its source — compiled in place, or stale — that `./lib.js` and `./lib` both
  // name, or `config.json` beside `config.ts` for `./config`. A package's files stay
  // what it compiled, as they do for the ES module resolver.
  if (resolvesSourceFirst(request, parent) && !inNodeModules(resolved)) {
    return sourceBeside(resolved) ?? extensionlessSource(request, resolved) ?? resolved;
  }
  return resolved;
};

// The files the ES module resolver tries, for a TypeScript importer, ahead of the
// compiled output a request names (`source_order` in `src/lib.rs`).
const SOURCES_BEFORE_OUTPUT = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// Every other file it tries for that request, which stand in for the output when it is
// missing: those, then `.jsx` for `./x.js` and `.js` for `./x.jsx`, which it tries
// after the named file.
const MISSING_OUTPUT_SOURCES = {
  ".js": [".ts", ".tsx", ".jsx"],
  ".jsx": [".tsx", ".ts", ".js"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// The extensions the ES module resolver tries for an extensionless request from a
// TypeScript importer, in its order. Node.js' CommonJS resolution tries `.js`, `.json`
// and `.node` first, then the extensions the `pirates` hook registers.
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  ".json",
  ".node",
];

// `.` and `..` themselves are relative too: `require("..")` names the parent directory.
const PATH_REQUEST = /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[a-zA-Z]:[\\/])/;

/**
 * @param {string} path
 * @returns {boolean}
 */
function inNodeModules(path) {
  return /[\\/]node_modules[\\/]/.test(path);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Whether the importer's tsconfig may map `request`, as the ES module resolver decides:
 * a bare request that is not a built-in module, from a file outside `node_modules`.
 *
 * @param {string} request
 * @param {{ filename?: string | null } | null | undefined} parent
 * @returns {parent is { filename: string }}
 */
function mapsThroughTsconfig(request, parent) {
  const filename = parent?.filename;
  return (
    typeof filename === "string" &&
    !inNodeModules(filename) &&
    !PATH_REQUEST.test(request) &&
    !isBuiltin(request)
  );
}

/**
 * Whether `parent` resolves `request` TypeScript first, as the ES module resolver
 * decides: a relative or absolute request from a TypeScript or JSX file outside
 * `node_modules`. The entry point has no parent and runs the file it names (#878).
 *
 * @param {string} request
 * @param {{ filename?: string | null } | null | undefined} parent
 * @returns {boolean}
 */
function resolvesSourceFirst(request, parent) {
  const filename = parent?.filename;
  return (
    typeof filename === "string" &&
    /\.(?:[cm]?ts|tsx|jsx)$/.test(filename) &&
    !inNodeModules(filename) &&
    PATH_REQUEST.test(request)
  );
}

/**
 * The TypeScript file a resolved JavaScript file may be compiled from, when it exists.
 *
 * @param {string} filename
 * @returns {string | undefined}
 */
function sourceBeside(filename) {
  return sourcesFor(filename, SOURCES_BEFORE_OUTPUT).find(isFile);
}

/**
 * The file the ES module resolver would find for an extensionless `request` that
 * Node.js resolved to `filename` by adding an extension it tries later, when one exists.
 *
 * @param {string} request
 * @param {string} filename
 * @returns {string | undefined}
 */
function extensionlessSource(request, filename) {
  // A request that names its file's extension resolves to that very name.
  const name = basename(request);
  const file = basename(filename);
  if (!file.startsWith(`${name}.`)) {
    return undefined;
  }
  const added = file.slice(name.length);
  const stem = filename.slice(0, -added.length);
  // An extension the ES module resolver does not try (`.es6`, `.es`) keeps its file.
  const index = SOURCE_EXTENSIONS.indexOf(added);
  return index === -1
    ? undefined
    : SOURCE_EXTENSIONS.slice(0, index)
        .map((extension) => stem + extension)
        .find(isFile);
}

/**
 * The files a relative or absolute request for compiled output may name, from `table`.
 *
 * @param {string} request
 * @param {Record<string, string[]>} table
 * @returns {string[]}
 */
function sourcesFor(request, table) {
  if (!PATH_REQUEST.test(request)) {
    return [];
  }
  const extension = /\.[cm]?jsx?$/.exec(request)?.[0];
  const sources = extension && table[extension];
  return sources ? sources.map((source) => request.slice(0, -extension.length) + source) : [];
}

if (typeof setSourceMapsSupport === "function") {
  setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
} else if (typeof process.setSourceMapsEnabled === "function") {
  process.setSourceMapsEnabled(true);
}

const transformer = new OxcTransformer(process.cwd(), HELPER_MODULE_NAME);
const SOURCEMAP_PREFIX = "\n//# sourceMappingURL=";
const SOURCEMAP_MIME = "data:application/json;charset=utf-8;base64,";

const NODE_MODULES_REGEX = /^(?:.*[\\/])?node_modules(?:[\\/].*)?$/;

// The first line of the binding's error for `require()` of an ES module with
// top-level await, which it words as Node.js does (`REQUIRE_ASYNC_MODULE_MESSAGE`).
const REQUIRE_ASYNC_MODULE_MESSAGE =
  "require() cannot be used on an ESM graph with top-level await. Use import() instead.";

addHook(
  (code, filename) => {
    let output;
    try {
      output = transformer.transform(filename, code);
    } catch (error) {
      // Node.js' own `require(esm)` reports this as `ERR_REQUIRE_ASYNC_MODULE`, which
      // code catches to fall back to `import()` (issue #842); the binding's errors can
      // only carry its `GenericFailure` status.
      if (error instanceof Error && error.message.startsWith(REQUIRE_ASYNC_MODULE_MESSAGE)) {
        error.code = "ERR_REQUIRE_ASYNC_MODULE";
      }
      throw error;
    } finally {
      // A transform reads the tsconfig of the file it compiles.
      if (watch) {
        flush(watch, takeWatchDependencies);
      }
    }
    let transformed = output.source();
    const sourceMap = output.sourceMap();

    if (sourceMap) {
      const inlineMap = Buffer.from(sourceMap, "utf8").toString("base64");
      transformed += SOURCEMAP_PREFIX + SOURCEMAP_MIME + inlineMap;
    }

    return transformed;
  },
  {
    ext: Array.from(DEFAULT_EXTENSIONS),
    // Whether a `require()`d dependency gets transformed is asked of the
    // binding, which keeps `OXC_TRANSFORM_ALL`'s grammar — absent, empty, "0"
    // and "false" mean none, "typescript" only the `.ts`/`.mts`/`.cts`/`.tsx`
    // family — in one place, and reads the mode at require time so a
    // `setTransformDeps()` call made after this module loaded still applies,
    // up to the first transform or resolve like everywhere else. The matcher
    // covers `node_modules` itself, so the built-in ignore stays off.
    ignoreNodeModules: false,
    matcher: (filename) => !NODE_MODULES_REGEX.test(filename) || transformsDep(filename),
  },
);

/**
 * Whether this request comes from `require()`.
 *
 * `module.register()` never showed `require()` to the hooks; `module.registerHooks()`
 * does. Those requests stay on Node.js' own CommonJS resolution and the `pirates` hook
 * above — exactly where they were before. Node.js resolves them correctly on its own:
 * the `pirates` hook registers the TypeScript extensions in `Module._extensions`, which
 * is what lets its CommonJS resolver complete `require('./foo')` to `./foo.ts`.
 *
 * The discriminator is `importAttributes`, the field that decides whether the native
 * hooks can run at all: `createResolve` and `load` both take it as a required property
 * and reject a context without it. A CommonJS context never carries it, an ESM context
 * always does — even when empty. `conditions` cannot be used for this: `--conditions`
 * appends its values to *every* request, so `--conditions=require` would send imports
 * down the CommonJS path (`ERR_MODULE_NOT_FOUND` for an extensionless specifier) and
 * `--conditions=import` would send `require()` down the ESM one.
 *
 * @param {{ importAttributes?: Record<string, string> } | undefined} context
 * @returns {boolean}
 */
function isCommonJsRequire(context) {
  return context?.importAttributes === undefined;
}

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  if (isCommonJsRequire(context)) {
    // CommonJS requests stay on Node.js' own resolution, where the
    // `Module._resolveFilename` patch above claims the helper specifiers.
    return nextResolve(specifier, context);
  }
  if (specifier.startsWith(HELPER_TAGGED_PREFIX)) {
    // The resolver table runs Node.js' own `createRequire` lookups, never the hook
    // chain, so an earlier-registered copy's resolve hook cannot re-claim a specifier.
    // The resolved URL is still passed down the chain so format detection and any
    // other hooks run on it; a specifier forwarded as-is is exactly what let an inner
    // hook rewrite `parentURL` to its own module.
    const resolved = resolveHelperPath(specifier);
    if (resolved !== undefined) {
      return nextResolve(pathToFileURL(resolved).href, context);
    }
    // The tagged copy is not registered here — let the specifier fail (or resolve)
    // the way it would have before the patch.
    return nextResolve(specifier, context);
  }
  if (specifier.startsWith(HELPER_SPECIFIER_PREFIX)) {
    // An untagged specifier was emitted by an older copy — an inner hook in this chain
    // may be that very copy and will resolve it to itself — or by the public
    // `transform` API inside a user project, whose own resolution goes first too.
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const resolved = resolveHelperPath(specifier);
      if (resolved !== undefined) {
        return nextResolve(pathToFileURL(resolved).href, context);
      }
      throw error;
    }
  }
  return createResolve(
    {
      getCurrentDirectory: () => process.cwd(),
    },
    specifier,
    context,
    nextResolve,
  );
}

/**
 * @type {import('node:module').LoadHook}
 */
function load(url, context, nextLoad) {
  if (isCommonJsRequire(context)) {
    return nextLoad(url, context);
  }
  // `module.registerHooks()`'s synchronous default load reads every file it is asked
  // about — CommonJS included, where `module.register()`'s asynchronous one returns a
  // null source. `oxcLoad` discards a `commonjs` result's source only when it is the
  // file itself: the `pirates` hook compiles it when the CommonJS machinery reads the
  // file, so transforming it here would run the transform twice (issue #820). A source
  // that is not the file came from another hook and is kept — for a `data:` or custom
  // scheme there is no file to defer to.
  const result = oxcLoad(url, context, nextLoad, HELPER_MODULE_NAME);
  // A CommonJS result carrying no source of its own is left to the CommonJS machinery,
  // which compiles it through the `pirates` hook above and its accurate inline source
  // map. Returning transformed source here instead costs stack trace precision: a throw
  // in a `.cts` entry gets reported at the transformed position rather than the original
  // one. Asking `oxcLoad` first is what keeps a CommonJS-reported file that actually
  // contains ESM syntax running as an ES module, and what keeps source another hook
  // supplied — which the CommonJS machinery cannot re-read — from being discarded.
  // `commonjs-typescript` — Node.js' own format for a `.ts` file it strips types from —
  // is not deferred, because that translator needs the source and rejects `null`; it is
  // passed through untouched so Node.js reports its own error
  // (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) for a `.ts` dependency instead of one
  // blaming the hook.
  if (result.format === "commonjs" && result.source == null) {
    // A null source is what `module.register()`'s asynchronous default load returned for
    // every CommonJS module, and it is the one shape that keeps `require()` inside such a
    // module working on every runtime: a source-bearing result made Node.js short-circuit
    // it incorrectly until https://github.com/nodejs/node/pull/62920.
    return { format: result.format, source: null, responseURL: result.responseURL ?? url };
  }
  return result;
}

/**
 * Whether `module.registerHooks()` can be relied on for everything this loader does.
 *
 * `registerHooks` itself landed in v22.15.0 and v23.5.0, but two defects kept it from
 * being a drop-in replacement for far longer, both verified against release binaries:
 *
 * - Until https://github.com/nodejs/node/pull/59011 a synchronous resolve hook had its
 *   `conditions` overridden, which breaks CommonJS named-export detection for a package
 *   imported from ESM: `import { jsx } from 'react/jsx-runtime'` fails with "does not
 *   provide an export named 'jsx'". Fixed in v24.5.0, backported to v22.19.0, and never
 *   backported to the end-of-life 23.x line.
 * - Until https://github.com/nodejs/node/pull/62920 `require()` inside an imported
 *   CommonJS module short-circuited incorrectly whenever a synchronous load hook handed
 *   back source for it, so a `.ts` entry point in a CommonJS package could not
 *   `require()` its own files. Fixed in v26.2.0. The `load` hook above only defers a
 *   CommonJS result when its source is the file itself — when another hook, or a
 *   fileless URL, supplies the source it is transformed and returned — so this defect
 *   can still reach it. v26.2.0 stays the floor anyway: it is the first release where
 *   the synchronous hooks are complete regardless of what a hook returns, and every
 *   runtime below it keeps exactly the behaviour it has today.
 *
 * Below v26.2.0 `module.register()` therefore stays in use, deprecation warning included.
 *
 * @returns {boolean}
 */
function canRegisterSyncHooks() {
  if (typeof registerHooks !== "function") {
    return false;
  }
  const [major, minor] = process.versions.node.split(".", 2).map(Number);
  return major > 26 || (major === 26 && minor >= 2);
}

// `module.register()` is deprecated — DEP0205, runtime-deprecated since v25.9.0 — and
// runs the hooks on a separate thread. Prefer the synchronous, in-thread
// `module.registerHooks()` on every runtime that implements it completely.
if (canRegisterSyncHooks()) {
  initTracing();
  // A hook records what it read or looked for, and then reports it.
  registerHooks(
    watch
      ? {
          load: withFlush(load, watch, takeWatchDependencies),
          resolve: withFlush(resolve, watch, takeWatchDependencies),
        }
      : { load, resolve },
  );
} else {
  // The hook thread has its own loader context, both natively and under WASI.
  // Freeze the effective settings here so a later setter cannot make CommonJS
  // and ESM use different configs. Send explicit discovery too: the hook thread's
  // environment can be an older snapshot than the registering worker's.
  // That thread has no `process.send`, so its watch reports use `watchPort`.
  const watchPort = watch ? createRelay(watch, takeWatchDependencies) : undefined;
  // The hook thread tags the helpers it emits with its own module's URL. A file it
  // compiles to CommonJS `require()`s them on this thread, so that tag resolves here
  // too, against this same copy.
  const esmHooks = import.meta.resolve("@oxc-node/core/esm");
  helperResolvers[helperTag(esmHooks)] = resolveHelper;
  register(esmHooks, {
    parentURL: import.meta.url,
    data: {
      tsconfig: freezeTsconfig(process.cwd()),
      transformDeps: freezeTransformDeps(),
      watchPort,
    },
    transferList: watchPort ? [watchPort] : [],
  });
}
