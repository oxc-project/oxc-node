import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isMainThread, MessageChannel } from "node:worker_threads";

import { createResolve, initTracing, load as oxcLoad } from "./index.js";

initTracing();

if (!isMainThread) {
  const mc = new MessageChannel();
  mc.port1.ref();
}

// Duplicated from register.mjs: this module runs on `module.register()`'s
// worker thread and shares nothing with the main thread.
//
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

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
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
    // `module.register()` hooks are asynchronous, so the fallback waits on a
    // rejected promise instead of a thrown error.
    const fallback = (error) => {
      const resolved = resolveHelperPath(specifier);
      if (resolved !== undefined) {
        return nextResolve(pathToFileURL(resolved).href, context);
      }
      throw error;
    };
    try {
      const result = nextResolve(specifier, context);
      return result && typeof result.then === "function" ? result.then((r) => r, fallback) : result;
    } catch (error) {
      return fallback(error);
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
  return oxcLoad(url, context, nextLoad, HELPER_MODULE_NAME);
}

export { load, resolve };
