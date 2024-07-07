/* auto-generated by NAPI-RS */
/* eslint-disable */
export declare class Output {
  /**
   * Returns the generated code
   * Cache the result of this function if you need to use it multiple times
   */
  source(): string
  /**
   * Returns the source map as a JSON string
   * Cache the result of this function if you need to use it multiple times
   */
  sourceMap(): string | null
}

export declare function initTracing(): void

export declare function load(url: string, context: LoadContext, nextLoad: (arg0: string, arg1?: LoadContext | undefined | null) => unknown): unknown | LoadFnOutput | PromiseRaw<LoadFnOutput>

export interface LoadContext {
  /** Export conditions of the relevant `package.json` */
  conditions?: Array<string>
  /** The format optionally supplied by the `resolve` hook chain */
  format: string
  /** An object whose key-value pairs represent the assertions for the module to import */
  importAttributes: Record<string, string>
}

export interface LoadFnOutput {
  format: string
  /** A signal that this hook intends to terminate the chain of `resolve` hooks. */
  shortCircuit?: boolean
  source?: string | Uint8Array | Buffer | null
}

export declare function resolve(specifier: string, context: ResolveContext, nextResolve: (arg0: string, arg1?: ResolveContext | undefined | null) => unknown): ResolveFnOutput | Promise<ResolveFnOutput>

export interface ResolveContext {
  /** Export conditions of the relevant `package.json` */
  conditions: Array<string>
  /** An object whose key-value pairs represent the assertions for the module to import */
  importAttributes: Record<string, string>
  parentURL?: string
}

export interface ResolveFnOutput {
  format: string | undefined | null
  shortCircuit: boolean
  url: string
  importAttributes: Record<string, string> | undefined | null
}

export declare function transform(path: string, code: string): Output

