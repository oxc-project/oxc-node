import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createResolve, initTracing, load as oxcLoad, resolveCjsSpecifier } from "./index.js";

initTracing();

// Extensions that oxc-node is responsible for transforming (TypeScript / JSX / etc.).
// Anything that resolves to a different kind of file (plain `.js`, `.cjs`, `.json`,
// native addons, …) is handed straight back to Node.js untouched.
//
// This is required for the synchronous `module.registerHooks()` loader: when a
// CommonJS module is resolved and loaded through a customization hook, Node.js can
// no longer follow transitive `require()` re-exports (e.g. `__export(require("./src"))`)
// while detecting named exports, so `import { foo } from "cjs-pkg"` would fail with
// "does not provide an export named 'foo'". The asynchronous `module.register()` loader
// (which ran hooks on a worker thread) did not have this limitation. By leaving such
// modules entirely to Node.js, its built-in CommonJS named-export detection keeps working.
const OXC_TRANSFORM_EXTENSIONS = /\.(?:[mc]?tsx?|jsx|es6?|es)$/;

function isOxcTransformable(url) {
  if (typeof url !== "string") {
    return false;
  }
  try {
    return OXC_TRANSFORM_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isCommonJsRequire(context) {
  return Array.isArray(context?.conditions) && context.conditions.includes("require");
}

// Complete an extensionless CommonJS `require()` specifier that points at a file
// oxc-node transforms, using oxc-node's own resolver (which honours tsconfig `paths`,
// package `exports`, conditions and symlinks). Under the synchronous
// `module.registerHooks()` loader, CommonJS `require()` is routed through this
// ESM-style resolve hook, whose `nextResolve` does not consult `Module._extensions`
// (where `pirates` installs its TypeScript handler). Returning a concrete `file:` URL
// lets the CommonJS loader find the file and `pirates` transpile it, matching the
// behaviour of the legacy `module.register()` worker-thread loader.
function completeCommonJsTypeScript(specifier, parentURL) {
  if (extname(specifier) !== "") {
    return undefined;
  }
  let parentPath;
  if (typeof parentURL === "string") {
    try {
      parentPath = fileURLToPath(parentURL);
    } catch {
      parentPath = undefined;
    }
  }
  const resolved = resolveCjsSpecifier(specifier, parentPath);
  if (typeof resolved === "string" && OXC_TRANSFORM_EXTENSIONS.test(resolved)) {
    return pathToFileURL(resolved).href;
  }
  return undefined;
}

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  // CommonJS `require()` (only reachable under `module.registerHooks()`). Keep these on
  // Node's built-in CommonJS resolution + `pirates` transpilation instead of oxc-node's
  // ESM resolver, which would hand the CommonJS loader an ESM `file:` URL it cannot load.
  // We only step in to complete an extensionless TypeScript/JSX specifier that Node's
  // CommonJS resolver would otherwise reject.
  if (isCommonJsRequire(context)) {
    const completed = completeCommonJsTypeScript(specifier, context.parentURL);
    if (completed !== undefined) {
      return { url: completed, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }

  // Let Node.js resolve first. If the target is not something oxc-node needs to
  // transform, return Node's own result verbatim — this keeps the resolution
  // metadata Node.js relies on (notably for CommonJS named-export detection in the
  // synchronous hooks loader) instead of round-tripping it through the native binding.
  //
  // Node's default resolver does not understand TypeScript-only constructs such as
  // tsconfig `paths` aliases or extensionless `.ts` imports, so a failure here simply
  // means the specifier needs oxc-node's resolver.
  try {
    const nodeResolved = nextResolve(specifier, context);
    if (nodeResolved && !isOxcTransformable(nodeResolved.url)) {
      return nodeResolved;
    }
  } catch {
    // Fall through to oxc-node's resolver below.
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
  // Files that oxc-node is not responsible for are deferred to Node.js so its native
  // CommonJS handling (including transitive re-export detection) keeps working.
  if (!isOxcTransformable(url)) {
    return nextLoad(url, context);
  }
  // CommonJS sources (e.g. `.cts`, or `.ts` inside a `"type": "commonjs"` scope) are
  // transpiled by the `pirates` CommonJS hook installed in `register.mjs`, which emits
  // CommonJS output with an accurate inline source map. Routing them through the ESM
  // `load` binding instead would yield ESM output and a mismatched source map, so defer
  // to Node.js (and thus `pirates`) for anything Node has classified as CommonJS.
  if (context?.format === "commonjs") {
    return nextLoad(url, context);
  }
  return oxcLoad(url, context, nextLoad);
}

export { load, resolve };
