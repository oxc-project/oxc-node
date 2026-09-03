import { createResolve, load as oxcLoad } from "./index.js";

/**
 * Whether `module.registerHooks()` can be used on this Node.js version.
 *
 * This is deliberately a version check and not a feature check: `registerHooks` itself
 * exists from v22.15.0 / v23.5.0, long before the synchronous hook API became usable as a
 * loader.
 *
 * The blocker is `require()`. When a CommonJS module is loaded through Node.js' ESM
 * CommonJS translator — which is how the entry point and anything reached by `import` are
 * loaded — a `require()` inside it is served by the ESM loader. Until v24.18.0 / v26.2.0
 * that `require()` reached the hooks with the **`import`** condition set, so a loader could
 * not tell it apart from a real `import`; and the module it produced then had to be
 * executed as an ES module, which Node.js only supports on this path from v22.22.3 /
 * v24.8.0 (before that it throws
 * `TypeError: Cannot read properties of undefined (reading 'exports')`).
 *
 * oxc-node handles the first problem — it reports the format that matches the code it
 * generates (see `transform_output` in `src/lib.rs`) — but not the second, so the floor is
 * v22.22.3 / v24.8.0. Node.js 20, 21 and 23 never got either change; 23 is end of life.
 *
 * Earlier versions have a third problem: until v22.19.0 / v24.5.0 the export conditions
 * were passed to hooks as a `SafeSet` rather than an array (`getCjsConditionsArray()`), so
 * `conditions.includes("require")` could not detect the CommonJS branch at all. That is
 * below the floor above, so it is covered.
 *
 * @param version the `x.y.z` version, e.g. `process.versions.node`
 * @returns {boolean}
 */
export function supportsRegisterHooks(version) {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (parsed === null) {
    return false;
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);
  if (major === 22) {
    return minor > 22 || (minor === 22 && patch >= 3);
  }
  if (major === 23) {
    return false;
  }
  return major > 24 || (major === 24 && minor >= 8);
}

/**
 * Whether the hook was called for a CommonJS `require()` rather than an `import`.
 *
 * A `Set` is still accepted even though {@link supportsRegisterHooks} keeps us off the
 * versions that pass one, so that a mistake there cannot silently turn every `require()`
 * into an `import`.
 *
 * @param {readonly string[] | Set<string> | undefined} conditions
 * @returns {boolean}
 */
function isCommonJs(conditions) {
  if (Array.isArray(conditions)) {
    return conditions.includes("require");
  }
  return typeof conditions?.has === "function" && conditions.has("require");
}

/**
 * The native binding types `conditions` as an array. See {@link isCommonJs} for why a
 * `Set` may still turn up.
 *
 * @template {{ conditions?: readonly string[] | Set<string> }} T
 * @param {T} context
 * @returns {T}
 */
function withArrayConditions(context) {
  const { conditions } = context;
  if (conditions === undefined || Array.isArray(conditions)) {
    return context;
  }
  return { ...context, conditions: Array.from(conditions) };
}

function getCurrentDirectory() {
  return process.cwd();
}

const RESOLVE_OPTIONS = { getCurrentDirectory };

/**
 * @type {import('node:module').ResolveHook}
 */
function resolve(specifier, context, nextResolve) {
  if (isCommonJs(context.conditions)) {
    // Leave the CommonJS `require()` path to Node.js, which is where the asynchronous
    // `module.register()` loader left it too: its hooks cannot serve a synchronous
    // `require()`, so `require()` never reached them. Node.js' CommonJS resolution honours
    // `Module._extensions`, where the `pirates` hook installed by `register.mjs` registers
    // every extension oxc-node transpiles, so `require("./foo")` still finds `foo.ts` — and
    // still prefers `foo.json` over `foo.ts`.
    return nextResolve(specifier, context);
  }
  return createResolve(
    RESOLVE_OPTIONS,
    specifier,
    withArrayConditions(context),
    withOriginalSpecifier(specifier, nextResolve),
  );
}

/**
 * Wrap `nextResolve` so the rest of the hook chain is asked about the specifier as it was
 * written, not about the URL oxc-node resolved it to.
 *
 * The native resolver resolves the specifier itself and then calls `nextResolve` with the
 * result, to have Node.js validate it and fill in the resolution metadata. Under
 * `module.register()` that was invisible: oxc-node's hooks ran on a separate loader thread,
 * after every in-thread hook, so those hooks always saw the original specifier. With
 * `module.registerHooks()` there is a single chain and oxc-node runs first, so passing the
 * resolved URL down would hide the specifier from module mocking and policy hooks.
 *
 * Node.js cannot resolve everything oxc-node can — tsconfig `paths` aliases, extensionless
 * TypeScript — so when it fails, fall back to asking about the resolved URL.
 *
 * @param {string} specifier
 * @param {import('node:module').ResolveHook} nextResolve
 * @returns {import('node:module').ResolveHook}
 */
function withOriginalSpecifier(specifier, nextResolve) {
  return (resolved, context) => {
    if (resolved !== specifier) {
      let output;
      try {
        output = nextResolve(specifier, context);
      } catch {
        // Only oxc-node can resolve this one.
        return nextResolve(resolved, context);
      }
      // These hooks only ever run under the synchronous `module.registerHooks()`, but the
      // hook signature allows a promise, and spreading one would silently produce garbage.
      if (output !== null && typeof output === "object" && !("then" in output)) {
        return { ...output, url: resolved };
      }
    }
    return nextResolve(resolved, context);
  };
}

/**
 * @type {import('node:module').LoadHook}
 */
function load(url, context, nextLoad) {
  if (isCommonJs(context.conditions)) {
    // Same reasoning as in `resolve`: `pirates` transpiles these, emitting a source map for
    // the code Node.js actually compiles, and Node.js keeps performing its own CommonJS
    // named-export detection on the result — including transitive
    // `__export(require("./src"))` re-exports.
    return nextLoad(url, context);
  }
  const loadContext = withArrayConditions(context);
  if (typeof loadContext.format !== "string" || !loadContext.format.startsWith("commonjs")) {
    return oxcLoad(url, loadContext, nextLoad);
  }
  // Node.js classified this module as CommonJS. Read it once and let the native loader
  // decide what it is:
  //
  // * Oxc does not lower ES modules to CommonJS, so its output is often still an ES module.
  //   The native loader reports `module` for it and Node.js executes that source — the only
  //   way such a module can be loaded on this path, and the reason `require()` of a
  //   transpiled file works at all.
  // * When the output really is CommonJS, Node.js compiles the file through
  //   `Module._extensions` — where `register.mjs` installs `pirates` — and ignores the
  //   source returned here. Returning the untouched original then matters: keeping our copy
  //   would register a second, conflicting source map for the same file and make stack
  //   traces point at generated positions.
  const original = nextLoad(url, loadContext);
  const transformed = oxcLoad(url, loadContext, () => original);
  return typeof transformed.format === "string" && transformed.format.startsWith("commonjs")
    ? original
    : transformed;
}

export { load, resolve };
