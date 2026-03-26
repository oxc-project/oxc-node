#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import process from "node:process";

import { Builtins, Cli, Command, Option, Usage } from "clipanion";

import pkgJson from "../package.json" with { type: "json" };

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
    const args = this.args.length ? `${this.args.join(" ")}` : "";
    const register = import.meta.resolve("@oxc-node/core/register");
    if (!args.length) {
      execSync(`node --enable-source-maps --import ${register}`, {
        env: process.env,
        cwd: process.cwd(),
        stdio: `inherit`,
      });
      return;
    }
    return new Promise<void>((resolve) => {
      const cp = spawn(`node`, [`--enable-source-maps`, `--import`, register, ...this.args], {
        env: process.env,
        cwd: process.cwd(),
        stdio: `inherit`,
      });
      cp.addListener(`error`, (error) => {
        console.error(error);
      });
      cp.addListener(`exit`, (code) => {
        process.exitCode = code ?? 0;
        resolve();
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
