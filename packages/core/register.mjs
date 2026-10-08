import { createHash } from "node:crypto";
import * as NodeModule from "node:module";
import { pathToFileURL } from "node:url";

import { addHook } from "pirates";

import { OxcTransformer, createResolve, initTracing, load as oxcLoad } from "./index.js";

// Destructure from NodeModule namespace to support older Node.js versions
const { Module, createRequire, register, registerHooks, setSourceMapsSupport } = NodeModule;

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
const HELPER_TAG =
  "c" +
  createHash("sha256")
    .update(import.meta.url)
    .digest("hex")
    .slice(0, 12);
const HELPER_MODULE_NAME = `${HELPER_TAGGED_PREFIX}${HELPER_TAG}`;

const requireHelper = createRequire(import.meta.url);

// Each copy's resolver lives in a realm-wide registry keyed by its tag. Tagged
// specifiers take exactly their owner's resolver; untagged ones — emitted by older
// published copies that know nothing of tagging — try every registered resolver,
// newest registration first.
const HELPER_RESOLVERS = Symbol.for("@oxc-node/core:helperResolvers");
const helperResolvers = (globalThis[HELPER_RESOLVERS] ??= {});
helperResolvers[HELPER_TAG] = (subpath) => requireHelper.resolve(`@oxc-node/core/${subpath}`);

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
Module._resolveFilename = function (request, parent, isMain, options) {
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
      } catch {
        globalThis[HELPER_RESOLVING] = true;
        try {
          const resolved = resolveHelperPath(request);
          if (resolved !== undefined) {
            return resolved;
          }
        } finally {
          globalThis[HELPER_RESOLVING] = false;
        }
        throw new Error(`Cannot find module '${request}'`);
      }
    }
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

if (typeof setSourceMapsSupport === "function") {
  setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
} else if (typeof process.setSourceMapsEnabled === "function") {
  process.setSourceMapsEnabled(true);
}

const transformer = new OxcTransformer(process.cwd(), HELPER_MODULE_NAME);
const SOURCEMAP_PREFIX = "\n//# sourceMappingURL=";
const SOURCEMAP_MIME = "data:application/json;charset=utf-8;base64,";

addHook(
  (code, filename) => {
    const output = transformer.transform(filename, code);
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
  const result = oxcLoad(url, context, nextLoad, HELPER_MODULE_NAME);
  // Anything oxc-node itself settles on as CommonJS is left to the CommonJS machinery,
  // which compiles it through the `pirates` hook above and its accurate inline source
  // map. Returning source from here instead costs stack trace precision: a throw in a
  // `.cts` entry gets reported at the transformed position rather than the original one.
  // Asking `oxcLoad` first is what keeps a CommonJS-reported file that actually contains
  // ESM syntax running as an ES module. `commonjs-typescript` — Node.js' own format for a
  // `.ts` file it strips types from — is not deferred, because that translator needs the
  // source and rejects `null`; it is passed through untouched so Node.js reports its own
  // error (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) for a `.ts` dependency instead
  // of one blaming the hook.
  if (result.format === "commonjs") {
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
 *   `require()` its own files. Fixed in v26.2.0. The `load` hook above never returns
 *   source for CommonJS, so this defect does not reach it — v26.2.0 is kept as the floor
 *   anyway, because it is the first release where the synchronous hooks are complete
 *   regardless of what a hook returns, and every runtime below it keeps exactly the
 *   behaviour it has today.
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
  registerHooks({ load, resolve });
} else {
  register("@oxc-node/core/esm", import.meta.url);
}
