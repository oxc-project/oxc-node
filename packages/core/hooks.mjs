import { createResolve, load as oxcLoad } from "./index.js";

/**
 * Whether `module.registerHooks()` can be used on this Node.js version.
 *
 * This is deliberately a version check and not a feature check: `registerHooks` itself
 * exists from v22.15.0 / v23.5.0, long before the synchronous hook API became usable as a
 * loader.
 *
 * Until v24.18.0 / v26.2.0, a `require()` made from a CommonJS module that Node.js itself
 * loaded through the ESM CommonJS translator was routed through the *ESM* resolver: the
 * `resolve` hook was handed the already resolved URL together with the **`import`**
 * condition set, and the module was then loaded as ESM. A loader cannot tell such a
 * `require()` apart from an `import`, so it hands the CommonJS loader an ES module and the
 * `require()` fails (`SyntaxError: Unexpected token 'export'`, or
 * `TypeError: Cannot read properties of undefined (reading 'exports')`). From v24.18.0 /
 * v26.2.0 the hook receives the original specifier with the `require` conditions and the
 * module is compiled through `Module._extensions`, where `register.mjs` installs `pirates`.
 *
 * Earlier versions have a second problem: until v22.19.0 / v24.5.0 the export conditions
 * were passed to hooks as a `SafeSet` rather than an array (`getCjsConditionsArray()`), so
 * `conditions.includes("require")` could not detect the CommonJS branch at all.
 *
 * Node.js 22, 23 and 25 never received the v24.18.0 fix and keep using
 * `module.register()`. Only v26.0.x and v26.1.x are both excluded here and
 * runtime-deprecating `module.register()` (DEP0205, from v26.0.0).
 *
 * @param {string | undefined} version the `x.y.z` version, e.g. `process.versions.node`
 * @returns {boolean}
 */
export function supportsRegisterHooks(version) {
  const parsed = /^v?(\d+)\.(\d+)\./.exec(version ?? "");
  if (parsed === null) {
    return false;
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  if (major === 24) {
    return minor >= 18;
  }
  if (major === 26) {
    return minor >= 2;
  }
  // Node.js 22, 23 and 25 are excluded; 27 and later inherit the fix from main.
  return major >= 27;
}

/** The extensions the `pirates` hook installed by `register.mjs` claims. */
export const DEFAULT_EXTENSIONS = [
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
];

const PIRATES_EXTENSIONS = new Set(DEFAULT_EXTENSIONS);

/**
 * Whether `pirates` will transpile this module, in which case the `load` hook must leave
 * it alone: transforming it here as well would register a second, conflicting source map
 * for the same file and report generated positions in stack traces.
 *
 * `pirates` only sees modules Node.js compiles through `Module._extensions`, which is
 * every module it classified as CommonJS, and it ignores `node_modules` — where the ESM
 * `load` binding still applies `OXC_TRANSFORM_ALL`.
 *
 * @param {string} url
 * @param {string | null | undefined} format
 * @returns {boolean}
 */
function isTranspiledByPirates(url, format) {
  if (typeof format !== "string" || !format.startsWith("commonjs") || !url.startsWith("file:")) {
    return false;
  }
  // Match on `pathname` so that a `?query` or `#fragment` cannot be mistaken for an
  // extension, and so percent-encoded path segments are handled.
  const { pathname } = new URL(url);
  const dot = pathname.lastIndexOf(".");
  if (dot === -1 || !PIRATES_EXTENSIONS.has(pathname.slice(dot).toLowerCase())) {
    return false;
  }
  return !pathname.includes("/node_modules/");
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
    // Leave the whole CommonJS `require()` path to Node.js, which is where the
    // asynchronous `module.register()` loader left it too: its hooks cannot serve a
    // synchronous `require()`, so `require()` never reached them. Node.js' CommonJS
    // resolution honours `Module._extensions`, where the `pirates` hook installed by
    // `register.mjs` registers every extension oxc-node transpiles, so `require("./foo")`
    // still finds `foo.ts` — and still prefers `foo.json` over `foo.ts`.
    return nextResolve(specifier, context);
  }
  return createResolve(RESOLVE_OPTIONS, specifier, withArrayConditions(context), nextResolve);
}

/**
 * @type {import('node:module').LoadHook}
 */
function load(url, context, nextLoad) {
  if (isCommonJs(context.conditions) || isTranspiledByPirates(url, context.format)) {
    return nextLoad(url, context);
  }
  return oxcLoad(url, withArrayConditions(context), nextLoad);
}

export { load, resolve };
