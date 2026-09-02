import type { LoadHook, ResolveHook } from "node:module";

/**
 * Whether `module.registerHooks()` can be used on this Node.js version. See the
 * implementation in `hooks.mjs` for the Node.js bugs that make older versions unusable.
 *
 * @param version the `x.y.z` version, e.g. `process.versions.node`
 */
export declare function supportsRegisterHooks(version: string | undefined): boolean;

export declare const resolve: ResolveHook;
export declare const load: LoadHook;
