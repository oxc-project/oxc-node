#!/usr/bin/env node

import process from "node:process";

import { Builtins, Cli, Command, Option, Usage } from "clipanion";

import pkgJson from "../package.json" with { type: "json" };
import { runChild, usesNodeWatch } from "./run.js";

const [node, app, ...stdArgs] = process.argv;

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

const cli = new Cli({
  binaryLabel: `oxnode`,
  binaryName: `${node} ${app}`,
  binaryVersion: pkgJson.version,
});

cli.register(MainCommand);
cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
void cli.runExit(stdArgs);
