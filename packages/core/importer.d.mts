export interface ImporterOptions {
  /**
   * Share one module map with every importer made with `moduleCache: true`, so a file
   * runs once per process. With `false`, each `import()` call runs the files it reaches
   * again; dependencies Node.js loads itself stay in Node.js' own cache.
   *
   * @default true
   */
  moduleCache?: boolean;
  /**
   * Return the namespace wrapped so that the properties of its `default` export can be
   * read from it too, as jiti does.
   *
   * @default true
   */
  interopDefault?: boolean;
}

export interface ResolveOptions {
  /** Resolve from this file instead of the importer's parent. */
  parentURL?: string | URL;
  /** Export conditions, in place of `["node", "import"]`. */
  conditions?: string[];
  /**
   * Return `undefined` instead of throwing when the module is not found, or its package
   * does not export it.
   */
  try?: boolean;
}

export interface ImportOptions extends ResolveOptions {
  /** Return the `default` export, or the namespace when it has none. */
  default?: true;
}

export interface Importer {
  /** Imports a module, TypeScript included, as `import()` would. */
  import<T = unknown>(id: string | URL, opts?: ImportOptions): Promise<T>;
  /**
   * Resolves a module as `import` would: a `file:` URL, or a `node:` id for a built-in
   * module.
   */
  resolve(id: string | URL, opts?: ResolveOptions): string | undefined;
}

/**
 * Creates an importer that resolves from `parentId` (a file path or `file:` URL; one
 * that ends in `/` is a directory), without installing anything in the process.
 */
export function createImporter(parentId: string | URL, options?: ImporterOptions): Importer;
