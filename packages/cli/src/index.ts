#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

import { Builtins, Cli, Command, Option, Usage } from "clipanion";

import pkgJson from "../package.json" with { type: "json" };
import { runChild, usesNodeWatch } from "./run.js";
import { runWatch } from "./watch/command.js";
import type { WatchGlob } from "./watch/messages.js";

const [node, app, ...stdArgs] = process.argv;

/** The binding's `GlobMatcher`, which the transform listed the files with. */
interface GlobMatcherClass {
  new (
    include: string[],
    exclude?: string[],
    dot?: boolean,
    nocase?: boolean,
  ): { matches(file: string): boolean };
}

let GlobMatcher: GlobMatcherClass | undefined;

/**
 * Matches the files of a `watch:glob` report as `import.meta.glob` listed them. The binding
 * loads on the first report, so a run without globs never loads it here.
 */
function globMatcher(glob: WatchGlob): (file: string) => boolean {
  GlobMatcher ??= (
    createRequire(import.meta.url)("@oxc-node/core") as { GlobMatcher: GlobMatcherClass }
  ).GlobMatcher;
  const matcher = new GlobMatcher(glob.include, glob.exclude, glob.dot, glob.nocase);
  return (file) => matcher.matches(file);
}

class MainCommand extends Command {
  static paths = [[]];

  static usage: Usage = {
    description: `Run a script with oxc transformer and oxc-resolver`,
    details: `oxnode is a CLI tool that runs a script with oxc transformer and oxc-resolver.
    The esm module is resolved by oxc-resolver and transformed by oxc transformer.
    The cjs module support will be added in the future.
    `,
    examples: [
      [`Run a script`, `oxnode ./src/index.ts`],
      [`repl`, `oxnode`],
      [`Watch mode`, `oxnode watch ./src/index.ts`],
    ],
  };

  help = Option.Boolean(`-h,--help`, false, {
    description: `Show help`,
  });

  nodeHelp = Option.Boolean(`--node-help`, false, {
    description: `Show Node.js help`,
  });

  args = Option.Proxy();

  async execute() {
    if (this.help) {
      this.context.stdout.write(this.cli.usage());
      return;
    }
    if (this.nodeHelp) {
      this.args.push(`--help`);
    }
    const register = import.meta.resolve("@oxc-node/core/register");
    // With no args this is the REPL. oxnode exits from `runChild` the way the child did.
    return new Promise<never>(() => {
      runChild(`node`, [`--enable-source-maps`, `--import`, register, ...this.args], {
        nodeWatch: usesNodeWatch(this.args),
      });
    });
  }
}

class WatchCommand extends Command {
  static paths = [[`watch`]];

  static usage: Usage = {
    description: `Run a script and run it again when a file it uses changes`,
    details: `Run \`oxnode watch --help\` for the options.`,
    examples: [[`Watch mode`, `oxnode watch ./src/index.ts`]],
  };

  // Everything, `--help` included, goes to the watch parser.
  args = Option.Proxy();

  async execute() {
    return runWatch(this.args, { globMatcher });
  }
}

const cli = new Cli({
  binaryLabel: `oxnode`,
  binaryName: `${node} ${app}`,
  binaryVersion: pkgJson.version,
});

cli.register(MainCommand);
cli.register(WatchCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
void cli.runExit(stdArgs);
