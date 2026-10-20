// The types of `@oxc-node/cli/watch`, kept in step with src/watch/command.ts.

export interface WatchOptions {
  /**
   * The Node.js flags that load the app's hooks, put before the user's Node.js options:
   * `node <loaderArgs> <node options> <entry> <script args>`.
   * Default: `["--enable-source-maps", "--import", "@oxc-node/core/register" as a URL]`.
   */
  loaderArgs?: string[];
  /**
   * Folders of the loader's own files, which show up in the module graph but are never
   * watched. Each folder's real path counts too. Default: the folder of
   * `@oxc-node/core/register` when `loaderArgs` is not given, else none.
   */
  ignoreDirs?: string[];
  /**
   * The command as the user types it, in errors, the usage line and `--help`. Its first
   * word tags the log lines. Default: `"oxnode watch"`.
   */
  name?: string;
}

/**
 * Run the watcher until it stops, and resolve with the exit code. Until then it owns
 * SIGINT, SIGTERM and SIGHUP, stdin (for Return) and the process's IPC channel.
 */
export declare function runWatch(argv: string[], options?: WatchOptions): Promise<number>;
