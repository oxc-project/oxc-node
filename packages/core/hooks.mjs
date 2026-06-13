import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `index.js` is CommonJS. Load it with `createRequire` rather than a named ESM import:
// its native exports are only statically detectable once oxc-node's own hooks are active,
// so a top-level `import { … } from "./index.js"` can fail to resolve freshly added
// exports in some bootstrap scenarios (e.g. `--eval` entrypoints).
const {
  createResolve,
  initTracing,
  load: oxcLoad,
  resolveCjsSpecifier,
} = createRequire(import.meta.url)("./index.js");

initTracing();

// File extensions oxc-node is responsible for transforming (TypeScript / JSX / etc.).
// Anything resolving to a different kind of file (plain `.js`, `.cjs`, `.json`, native
// addons, …) is handed straight back to Node.js untouched. This matters for the
// synchronous `module.registerHooks()` loader: when a CommonJS module is resolved and
// loaded through a customization hook, Node.js can no longer follow transitive
// `require()` re-exports (e.g. `__export(require("./src"))`) while detecting named
// exports, so `import { foo } from "cjs-pkg"` would fail. The legacy `module.register()`
// worker-thread loader did not have this limitation. By leaving such modules entirely to
// Node.js, its built-in CommonJS named-export detection keeps working.
// Extensions oxc-node actually transforms. Matched against the raw resolved string
// (no `new URL()` allocation, which dominated the hot path) — extension characters are
// never percent-encoded, so a substring match is safe.
const TRANSFORM_EXTENSION = /\.(?:[mc]?tsx?|jsx|es6?|es)(?:[?#]|$)/;

// Whether a resolved URL/path points at a file oxc-node must transform.
function needsTransform(url) {
  return typeof url === "string" && TRANSFORM_EXTENSION.test(url);
}

// Complete an extensionless CommonJS `require()` specifier that points at a file oxc-node
// transforms, using oxc-node's own resolver (which honours tsconfig `paths`, package
// `exports`, conditions and symlinks). Under `module.registerHooks()`, CommonJS
// `require()` is routed through this ESM-style resolve hook, whose `nextResolve` does not
// consult `Module._extensions` (where `pirates` installs its TypeScript handler).
// Returning a concrete `file:` URL lets the CommonJS loader find the file and `pirates`
// transpile it, matching the legacy `module.register()` worker-thread loader.
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
  if (needsTransform(resolved)) {
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
  // We only step in to complete an extensionless TypeScript/JSX specifier Node would reject.
  if (context?.conditions?.includes("require")) {
    const completed = completeCommonJsTypeScript(specifier, context.parentURL);
    return completed !== undefined
      ? { url: completed, shortCircuit: true }
      : nextResolve(specifier, context);
  }

  // Let Node.js resolve first. If the target is not something oxc-node transforms, return
  // Node's own result verbatim — preserving the resolution metadata Node relies on
  // (notably for CommonJS named-export detection) instead of round-tripping it through the
  // native binding. Node's resolver cannot handle TypeScript-only constructs (tsconfig
  // `paths`, extensionless `.ts`, …), so a failure simply means oxc-node must resolve it.
  try {
    const nodeResolved = nextResolve(specifier, context);
    if (nodeResolved !== undefined && !needsTransform(nodeResolved.url)) {
      return nodeResolved;
    }
  } catch {
    // Fall through to oxc-node's resolver below.
  }
  return createResolve({ getCurrentDirectory: getCwd }, specifier, context, nextResolve);
}

function getCwd() {
  return process.cwd();
}

/**
 * @type {import('node:module').LoadHook}
 */
function load(url, context, nextLoad) {
  // Cheap checks first: only transform when Node classified the module as ESM ("module")
  // and it is a file oxc-node owns. CommonJS sources (`.cts`, or `.ts` in a
  // `"type": "commonjs"` scope) are transpiled by the `pirates` CommonJS hook installed in
  // `register.mjs`, which emits CommonJS output with an accurate inline source map; routing
  // them through the ESM `load` binding would yield ESM output and a mismatched source map.
  if (context?.format === "commonjs" || !needsTransform(url)) {
    return nextLoad(url, context);
  }
  return oxcLoad(url, context, nextLoad);
}

export { load, resolve };
