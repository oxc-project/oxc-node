import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const CORE_PATH = fileURLToPath(new URL("../../core", import.meta.url));

// A legacy (`experimentalDecorators`) decorator is emitted through the
// `_decorate` helper and is called with (target, key, descriptor). Without the
// option the transform fails with `NO_LEGACY_DECORATORS`, since no Node.js
// release could run the decorator syntax it would otherwise leave behind.
const DECORATED = `let seen = "absent";
function dec(...args: any[]): any {
  seen =
    args.length === 3 && args[2] && typeof args[2] === "object" && "value" in args[2]
      ? "legacy"
      : "modern";
  return args[2];
}
class A {
  @dec
  method() {
    return 1;
  }
}
console.log("DECORATOR:" + seen);
`;

// Prints what the transformer emits for one file, so a spec can assert on the
// output rather than on a decorator that may not even be valid JavaScript.
const DUMP = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OxcTransformer } from "@oxc-node/core";
const file = resolve(process.argv[2]);
const transformer = new OxcTransformer(process.cwd());
console.log(transformer.transform(file, readFileSync(file, "utf8")).source());
`;

const NO_LEGACY_DECORATORS = '"experimentalDecorators": true';

const DECORATORS_TSCONFIG = JSON.stringify({
  compilerOptions: { experimentalDecorators: true, target: "ES2022" },
});

// The resolver is memoised in a process-wide `OnceLock`, so every scenario needs
// its own subprocess with its own working directory and environment.
const createProject = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "oxc-tsconfig-"));
  mkdirSync(join(root, "node_modules", "@oxc-node"), { recursive: true });
  symlinkSync(CORE_PATH, join(root, "node_modules", "@oxc-node", "core"), "dir");
  writeFileSync(join(root, "dump.mjs"), DUMP);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
};

// Node itself writes to stderr for reasons that have nothing to do with the
// scenario under test. The `test-wasi` CI job runs the whole suite with
// `NAPI_RS_FORCE_WASI=true`, and loading the WASI binding makes every
// subprocess print `ExperimentalWarning: WASI is an experimental feature`,
// which would fail each `stderr` assertion below even though the run
// succeeded. Drop Node's own warnings and keep everything else, so a real
// error still fails the test. `stdin-tty.spec.ts` filters the same two lines.
const stripNodeWarnings = (stderr: string) =>
  stderr
    .split("\n")
    .filter(
      (line) =>
        !line.includes("ExperimentalWarning") && !line.includes("Use `node --trace-warnings"),
    )
    .join("\n")
    .trim();

const runNode = (cwd: string, args: string[], env: Record<string, string | undefined> = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      // Continuous integration sets both globally, and the tracing layer writes
      // to stdout, which would drown the assertions below.
      OXC_LOG: undefined,
      DEBUG: undefined,
      ...env,
    },
  });
  return { ...result, stderr: stripNodeWarnings(result.stderr) };
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches stderr that holds exactly one warning that `path` could not be read.
 * On macOS the temporary directory is a symlink, so the resolver may report
 * the canonical `/private` path.
 */
const warning = (path: string, outcome: string) =>
  new RegExp(
    `^oxc-node: warning: failed to read the tsconfig (/private)?${escapeRegExp(path)}: [^\n]+; ${outcome}$`,
  );

/** The code the transformer emits for `entry`, run from `cwd` inside `root`. */
const emit = (root: string, cwd: string, entry: string, env?: Record<string, string | undefined>) =>
  runNode(cwd, [join(root, "dump.mjs"), entry], env);

/** Runs `entry` through the ESM resolve and load hooks. */
const runWithHooks = (cwd: string, entry: string, env?: Record<string, string | undefined>) =>
  runNode(cwd, ["--import", "@oxc-node/core/register", entry], env);

test("a sub-project with no tsconfig inherits the nearest ancestor that claims it", () => {
  const root = createProject({ "tsconfig.json": DECORATORS_TSCONFIG, "sub/entry.ts": DECORATED });
  try {
    const emitted = emit(root, join(root, "sub"), "./entry.ts");
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout, "the root config should apply to sub/entry.ts").toContain("_decorate");

    const ran = runWithHooks(join(root, "sub"), "./entry.ts");
    expect(ran.stdout.trim(), "legacy decorators should be transformed").toBe("DECORATOR:legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ancestor tsconfig whose include does not cover the file is not applied", () => {
  const root = createProject({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { experimentalDecorators: true, target: "ES2022" },
      include: ["other"],
    }),
    "other/covered.ts": DECORATED,
    "sub/entry.ts": DECORATED,
  });
  try {
    const excluded = emit(root, join(root, "sub"), "./entry.ts");
    expect(excluded.stderr, "sub/ is outside include, so no config applies").toContain(
      NO_LEGACY_DECORATORS,
    );

    const covered = emit(root, join(root, "other"), "./covered.ts");
    expect(covered.stdout, "other/ is inside include, so the config applies").toContain(
      "_decorate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken project reference in an ancestor that does not own the file breaks nothing", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022" },
      include: ["owned"],
      references: [{ path: "./missing" }],
    }),
    "owned/thing.ts": "export const y = 1;\n",
    "sub/dep.ts": 'export const x = "dep-ok";\n',
    "sub/entry.ts": 'import { x } from "./dep.js";\nconsole.log("resolved:" + x);\n',
  });
  try {
    const ran = runWithHooks(join(root, "sub"), "./entry.ts");
    expect(ran.stderr, "the missing reference is reported, nothing more").toMatch(
      new RegExp(
        `^oxc-node: warning: the tsconfig (/private)?${escapeRegExp(join(root, "missing"))}, which a tsconfig extends or references, does not exist; ignoring it$`,
      ),
    );
    expect(ran.stdout.trim(), "./dep.js should still resolve to dep.ts").toBe("resolved:dep-ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit TS_NODE_PROJECT that does not exist disables discovery entirely", () => {
  const root = createProject({ "tsconfig.json": DECORATORS_TSCONFIG, "sub/entry.ts": DECORATED });
  try {
    const emitted = emit(root, join(root, "sub"), "./entry.ts", {
      TS_NODE_PROJECT: join(root, "does-not-exist.json"),
    });
    expect(emitted.stderr, "an explicit missing config must not fall back to discovery").toContain(
      NO_LEGACY_DECORATORS,
    );
    expect(emitted.stderr, "the missing config must be reported").toContain(
      `oxc-node: warning: the tsconfig TS_NODE_PROJECT names, ${join(root, "does-not-exist.json")}, does not exist; running without a tsconfig`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit tsconfig still wins over discovery", () => {
  const root = createProject({
    "elsewhere/tsconfig.json": DECORATORS_TSCONFIG,
    "sub/entry.ts": DECORATED,
  });
  try {
    const emitted = emit(root, join(root, "sub"), "./entry.ts", {
      TS_NODE_PROJECT: join(root, "elsewhere", "tsconfig.json"),
    });
    expect(emitted.stdout, "the explicitly named config should apply").toContain("_decorate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty TS_NODE_PROJECT is treated as unset", () => {
  const root = createProject({
    "tsconfig.json": DECORATORS_TSCONFIG,
    "elsewhere/tsconfig.json": DECORATORS_TSCONFIG,
    "sub/entry.ts": DECORATED,
  });
  try {
    const discovered = emit(root, join(root, "sub"), "./entry.ts", { TS_NODE_PROJECT: "" });
    expect(discovered.stdout, "an empty value should not disable discovery").toContain("_decorate");

    const explicit = emit(root, join(root, "sub"), "./entry.ts", {
      TS_NODE_PROJECT: "",
      OXC_TSCONFIG_PATH: join(root, "elsewhere", "tsconfig.json"),
    });
    expect(explicit.stdout, "an empty value should not shadow OXC_TSCONFIG_PATH").toContain(
      "_decorate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `setTsconfigPath` names the config without touching `process.env`, so a
// wrapper's choice does not leak into the script or the processes it spawns
// (issue #806).
const SET_AND_DUMP = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OxcTransformer, setTsconfigPath } from "@oxc-node/core";
setTsconfigPath(process.argv[3]);
const file = resolve(process.argv[2]);
const transformer = new OxcTransformer(process.cwd());
console.log(transformer.transform(file, readFileSync(file, "utf8")).source());
console.log("ENV:" + (process.env.OXC_TSCONFIG_PATH ?? "unset"));
`;

test("setTsconfigPath pins a config and wins over the environment variables", () => {
  const root = createProject({
    "elsewhere/tsconfig.json": DECORATORS_TSCONFIG,
    "sub/entry.ts": DECORATED,
    "set-and-dump.mjs": SET_AND_DUMP,
  });
  try {
    // A relative path resolves against the loader's working directory.
    const emitted = runNode(
      join(root, "sub"),
      [join(root, "set-and-dump.mjs"), "./entry.ts", "../elsewhere/tsconfig.json"],
      // Either variable on its own would disable tsconfig handling.
      {
        TS_NODE_PROJECT: join(root, "does-not-exist.json"),
        OXC_TSCONFIG_PATH: join(root, "does-not-exist.json"),
      },
    );
    expect(emitted.stderr, "dump should not fail").toBe("");
    expect(emitted.stdout, "the config passed to the API should apply").toContain("_decorate");
    expect(emitted.stdout, "process.env should be left untouched").toContain(
      "ENV:" + join(root, "does-not-exist.json"),
    );

    const cleared = runNode(join(root, "sub"), [join(root, "set-and-dump.mjs"), "./entry.ts", ""], {
      OXC_TSCONFIG_PATH: join(root, "elsewhere", "tsconfig.json"),
    });
    expect(cleared.stdout, "an empty path should fall back to the environment").toContain(
      "_decorate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setTsconfigPath applies to the ESM resolve and load hooks", () => {
  const root = createProject({
    "elsewhere/tsconfig.json": DECORATORS_TSCONFIG,
    "sub/entry.ts": DECORATED,
    // An ES module is transformed on the `module.register()` hook thread below
    // Node.js 26.2, which under WASI has its own copy of the binding.
    "sub/entry.mts": DECORATED,
    "setup.mjs": `import { fileURLToPath } from "node:url";
import { setTsconfigPath } from "@oxc-node/core";
setTsconfigPath(fileURLToPath(new URL("./elsewhere/tsconfig.json", import.meta.url)));
await import("@oxc-node/core/register");
`,
  });
  try {
    for (const entry of ["./entry.ts", "./entry.mts"]) {
      const ran = runNode(join(root, "sub"), [
        "--import",
        pathToFileURL(join(root, "setup.mjs")).href,
        entry,
      ]);
      expect(ran.stderr, `${entry} should not fail`).toBe("");
      expect(ran.stdout.trim(), `legacy decorators should be transformed in ${entry}`).toBe(
        "DECORATOR:legacy",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setTsconfigPath throws once the config is in use, unless it names the same one", () => {
  const root = createProject({
    "elsewhere/tsconfig.json": DECORATORS_TSCONFIG,
    "other/tsconfig.json": DECORATORS_TSCONFIG,
    "env.mjs": `import { join } from "node:path";
import { OxcTransformer, getTsconfigPath, setTsconfigPath } from "@oxc-node/core";
new OxcTransformer(process.cwd()).transform("entry.ts", "export {}");
const path = join(process.cwd(), "elsewhere", "tsconfig.json");
setTsconfigPath(path);
console.log(getTsconfigPath() === path ? "ENV:ok" : "ENV:not remembered");
`,
    "late.mjs": `import { OxcTransformer, setTsconfigPath } from "@oxc-node/core";
setTsconfigPath("elsewhere/tsconfig.json");
new OxcTransformer(process.cwd()).transform("entry.ts", "export {}");
setTsconfigPath("elsewhere/tsconfig.json");
console.log("SAME:ok");
try {
  setTsconfigPath("other/tsconfig.json");
  console.log("OTHER:accepted");
} catch (error) {
  console.log("OTHER:" + error.message);
}
`,
  });
  try {
    const ran = runNode(root, [join(root, "late.mjs")]);
    expect(ran.stderr, "the run should not fail").toBe("");
    expect(ran.stdout).toContain("SAME:ok");
    expect(ran.stdout).toContain(
      "OTHER:setTsconfigPath() must be called before the first transform or resolve",
    );

    // A config that came from the environment is just as much "in use".
    const fromEnv = runNode(root, [join(root, "env.mjs")], {
      OXC_TSCONFIG_PATH: "elsewhere/tsconfig.json",
    });
    expect(fromEnv.stderr, "the run should not fail").toBe("");
    expect(fromEnv.stdout).toContain("ENV:ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory named tsconfig.json does not stop the ancestor walk", () => {
  const root = createProject({
    "tsconfig.json": DECORATORS_TSCONFIG,
    "mid/tsconfig.json/placeholder.txt": "not a config\n",
    "mid/entry.ts": DECORATED,
  });
  try {
    const emitted = emit(root, join(root, "mid"), "./entry.ts");
    expect(emitted.stdout, "the walk should continue past the directory").toContain("_decorate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `oxc_resolver` follows TypeScript's program-membership rule, under which a
// `.js` / `.jsx` / `.mjs` / `.cjs` file is never an input unless `allowJs` is
// set. A loader asks a different question — which project does this file belong
// to — so path aliases have to keep working for JavaScript importers, without
// anyone having to turn `allowJs` on.
const ALIAS_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ESNext",
    paths: { "@subdirectory/*": ["./src/subdirectory/*"] },
  },
  include: ["src"],
});
const ALIAS_IMPORTER = (label: string) =>
  `import { bar } from "@subdirectory/bar.mts";\nconsole.log("${label}:" + bar());\n`;

test("tsconfig paths apply to JavaScript importers with allowJs unset", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": ALIAS_TSCONFIG,
    "src/subdirectory/bar.mts": 'export const bar = () => "bar";\n',
    // Deliberately distinct basenames: the `.ts` path the probe asks about must
    // not exist, because ownership is decided lexically and never stats it.
    "src/from-mjs.mjs": ALIAS_IMPORTER("mjs"),
    "src/from-js.js": ALIAS_IMPORTER("js"),
    "src/from-ts.ts": ALIAS_IMPORTER("ts"),
  });
  try {
    for (const [entry, label] of [
      ["./from-mjs.mjs", "mjs"],
      ["./from-js.js", "js"],
      ["./from-ts.ts", "ts"],
    ]) {
      const ran = runWithHooks(join(root, "src"), entry);
      expect(ran.stderr, `${entry} should resolve its alias`).toBe("");
      expect(ran.stdout.trim(), `${entry} should resolve its alias`).toBe(`${label}:bar`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// tsx applies a config's `paths` to every importer outside node_modules,
// including files `exclude` names; only compiler options honour `exclude`.
// The nearest-ancestor fallback in `for_importer` matches that, so the runs
// below resolve their aliases, while `for_path` keeps compiler options off the
// excluded files.
test("tsconfig paths apply to importers the config excludes, for resolution only", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        paths: { "@subdirectory/*": ["./src/subdirectory/*"] },
      },
      include: ["src"],
      exclude: ["src/excluded"],
    }),
    "src/subdirectory/bar.mts": 'export const bar = () => "bar";\n',
    "src/excluded/from-mjs.mjs": ALIAS_IMPORTER("mjs"),
    "src/excluded/from-ts.ts": ALIAS_IMPORTER("ts"),
  });
  try {
    for (const [entry, label] of [
      ["./from-mjs.mjs", "mjs"],
      ["./from-ts.ts", "ts"],
    ]) {
      const ran = runWithHooks(join(root, "src", "excluded"), entry);
      expect(ran.stderr, `${entry} should resolve its alias`).toBe("");
      expect(ran.stdout.trim(), `${entry} should resolve its alias`).toBe(`${label}:bar`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The issue #835 layout: the root config covers `src`, and a repository script
// outside `include` imports the same aliases. No config claims the script, so
// the nearest ancestor `tsconfig.json` answers for resolution. The `.mjs`
// importer exercises the full chain — discovery, then the JavaScript probe,
// then the fallback.
test("tsconfig paths apply to an importer outside the root config's include", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src"],
    }),
    "src/lib/x.ts": 'export const x = "from lib";\n',
    "scripts/seed.ts": 'import { x } from "@lib/x.ts";\nconsole.log("ts:" + x);\n',
    "scripts/seed.mjs": 'import { x } from "@lib/x.ts";\nconsole.log("mjs:" + x);\n',
  });
  try {
    for (const [entry, label] of [
      ["./seed.ts", "ts"],
      ["./seed.mjs", "mjs"],
    ]) {
      const ran = runWithHooks(join(root, "scripts"), entry);
      expect(ran.stderr, `${entry} should resolve its alias`).toBe("");
      expect(ran.stdout.trim(), `${entry} should resolve its alias`).toBe(`${label}:from lib`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The split the fallback must keep: the same config whose `paths` now reach
// `scripts/` for resolution must not compile it. Ownership still decides
// compiler options (`for_path` is unchanged), so a decorator in `scripts/`
// fails exactly as it did before the fallback existed.
test("compiler options still do not reach a directory the config does not include", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        experimentalDecorators: true,
        target: "ES2022",
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src"],
    }),
    "src/lib/x.ts": 'export const x = "from lib";\n',
    "scripts/seed.ts": 'import { x } from "@lib/x.ts";\nconsole.log("ts:" + x);\n',
    "scripts/decorated.ts": DECORATED,
  });
  try {
    const ran = runWithHooks(join(root, "scripts"), "./seed.ts");
    expect(ran.stderr, "the alias should resolve through the fallback").toBe("");
    expect(ran.stdout.trim(), "the alias should resolve through the fallback").toBe("ts:from lib");

    const emitted = emit(root, join(root, "scripts"), "./decorated.ts");
    expect(emitted.stderr, "scripts/ is outside include, so no compiler options").toContain(
      NO_LEGACY_DECORATORS,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Neither config claims `sub/scripts/seed.ts`: the root covers only `src` and
// the sub-project only `lib`. The fallback takes the nearer of the two, so the
// alias resolves through the sub-project's `paths`, not the root's.
test("the nearest tsconfig wins when no ancestor config claims the file", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "@lib/x.ts": ["src/root-x.ts"] },
      },
      include: ["src"],
    }),
    "src/root-x.ts": 'export const x = "root-x";\n',
    "sub/tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "@lib/x.ts": ["lib/sub-x.ts"] },
      },
      include: ["lib"],
    }),
    "sub/lib/sub-x.ts": 'export const x = "sub-x";\n',
    "sub/scripts/seed.ts": 'import { x } from "@lib/x.ts";\nconsole.log("nearest:" + x);\n',
  });
  try {
    const ran = runWithHooks(join(root, "sub", "scripts"), "./seed.ts");
    expect(ran.stderr, "the alias should resolve through the nearest config").toBe("");
    expect(ran.stdout.trim(), "the sub config is nearer than the root").toBe("nearest:sub-x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The fallback must never reach a dependency: without the node_modules guard
// the ancestor walk would escape the package and hand it the workspace root's
// aliases. Plain `.mjs`, so no transform is involved — only the resolve hook.
test("no tsconfig fallback for importers inside node_modules", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src"],
    }),
    "src/lib/x.ts": 'export const x = "from lib";\n',
    "node_modules/some-dep/entry.mjs": 'import { x } from "@lib/x.ts";\nconsole.log("dep:" + x);\n',
  });
  try {
    const ran = runWithHooks(join(root, "node_modules", "some-dep"), "./entry.mjs");
    expect(ran.status, "a dependency must not see the workspace root's aliases").not.toBe(0);
    expect(ran.stderr, "a dependency must not see the workspace root's aliases").toContain(
      "ERR_MODULE_NOT_FOUND",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// tsx applies only `paths`/`baseUrl` — never `rootDirs`, which is the one
// thing a tsconfig context adds to RELATIVE resolution in oxc_resolver. The
// nearest-ancestor fallback therefore serves bare specifiers only: a missing
// `./dep.js` in the importer's own root must fail exactly as it does under tsx
// and plain Node.js, never escape to another configured root. Bare aliases
// through the same config keep working.
test("the fallback does not extend rootDirs to relative imports", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        rootDirs: ["a", "b"],
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src"],
    }),
    "src/lib/x.ts": 'export const x = "from lib";\n',
    "a/seed.ts": 'import { x } from "@lib/x.ts";\nconsole.log("alias:" + x);\n',
    "a/relative.ts": 'import { dep } from "./dep.js";\nconsole.log("relative:" + dep);\n',
    "b/dep.ts": 'export const dep = "from-b";\n',
  });
  try {
    const aliased = runWithHooks(join(root, "a"), "./seed.ts");
    expect(aliased.stderr, "the alias should still resolve through the fallback").toBe("");
    expect(aliased.stdout.trim(), "the alias should still resolve through the fallback").toBe(
      "alias:from lib",
    );

    const relative = runWithHooks(join(root, "a"), "./relative.ts");
    expect(relative.status, "rootDirs must not redirect a missing relative import").not.toBe(0);
    expect(relative.stderr, "rootDirs must not redirect a missing relative import").toContain(
      "ERR_MODULE_NOT_FOUND",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// An absolute specifier names a file: the fallback must not let a catch-all
// `paths` mapping redirect it (`resolve_with_context` tries `paths` before
// absolute resolution). tsx and plain Node.js resolve the requested file;
// only bare specifiers consult the nearest config.
test("the fallback does not redirect absolute specifiers through catch-all paths", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "*": ["src/shim.ts"] },
      },
      include: ["src"],
    }),
    "src/shim.ts": 'export const v = "shimmed";\n',
    "outside/x.ts": 'export const v = "real";\n',
  });
  // The seeds need the fixture's own absolute path, so they are written after
  // `createProject` returns the root. The second uses a single-slash `file:`
  // URL, a spelling Node.js accepts (WHATWG normalizes it to `file:///…`) that
  // carries no `://` (`file:C:/x.ts` on Windows).
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts", "seed.ts"),
    `import { v } from ${JSON.stringify(join(root, "outside", "x.ts"))};\nconsole.log("abs:" + v);\n`,
  );
  writeFileSync(
    join(root, "scripts", "file-url.ts"),
    `import { v } from ${JSON.stringify(`file:${join(root, "outside", "x.ts")}`)};\nconsole.log("file-url:" + v);\n`,
  );
  // A custom scheme belongs to Node.js or another loader in the chain:
  // `paths` trying first would steal the specifier from its owner, so the
  // fallback must leave it alone (tsx aliases it; that is tsx's bug to keep).
  writeFileSync(
    join(root, "scripts", "scheme.ts"),
    'import { v } from "virtual:module";\nconsole.log("scheme:" + v);\n',
  );
  // WHATWG URL parsing trims leading/trailing controls and spaces and drops
  // ASCII tab/newline before scheme detection: the first spelling loads as a
  // file: URL under plain Node.js, the second is rejected — and neither may
  // be stolen by the catch-all on the way there.
  writeFileSync(
    join(root, "scripts", "space-url.ts"),
    `import { v } from ${JSON.stringify(` file:${join(root, "outside", "x.ts")}`)};\nconsole.log("space-url:" + v);\n`,
  );
  writeFileSync(
    join(root, "scripts", "tab-url.ts"),
    `import { v } from ${JSON.stringify(`fi\ttle://${join(root, "outside", "x.ts")}`)};\nconsole.log("tab-url:" + v);\n`,
  );
  try {
    const ran = runWithHooks(join(root, "scripts"), "./seed.ts");
    expect(ran.stderr, "an absolute specifier must resolve to the file it names").toBe("");
    expect(ran.stdout.trim(), "an absolute specifier must resolve to the file it names").toBe(
      "abs:real",
    );

    const fileUrl = runWithHooks(join(root, "scripts"), "./file-url.ts");
    expect(fileUrl.stderr, "a single-slash file: URL must load the file it names").toBe("");
    expect(fileUrl.stdout.trim(), "a single-slash file: URL must load the file it names").toBe(
      "file-url:real",
    );

    const scheme = runWithHooks(join(root, "scripts"), "./scheme.ts");
    expect(
      scheme.stdout,
      "the catch-all shim must not execute for a schemed specifier",
    ).not.toContain("shimmed");
    expect(scheme.stderr, "Node.js itself rejects the unknown scheme").toContain(
      "ERR_UNSUPPORTED_ESM_URL_SCHEME",
    );

    const spaceUrl = runWithHooks(join(root, "scripts"), "./space-url.ts");
    expect(spaceUrl.stderr, "a space-padded file: URL must load the file it names").toBe("");
    expect(spaceUrl.stdout.trim(), "a space-padded file: URL must load the file it names").toBe(
      "space-url:real",
    );

    const tabUrl = runWithHooks(join(root, "scripts"), "./tab-url.ts");
    expect(tabUrl.stdout, "the catch-all shim must not execute").not.toContain("shimmed");
    if (tabUrl.status === 0) {
      // Whether Node.js then loads or rejects the tab-mangled URL is its own
      // platform behavior; the fallback must simply stay out of it.
      expect(tabUrl.stdout.trim(), "if Node.js loads it, it must be the named file").toBe(
        "tab-url:real",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A broken nearest config is "no config", exactly as `discover` treats a
// broken ancestor: the alias must not resolve, and the walk must not continue
// past it to the valid root config. Everything that needs no config — the
// relative import — keeps working.
test("a broken nearest tsconfig means no fallback and the walk stops", () => {
  const project = (seed: string) => ({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        target: "ESNext",
        paths: { "@lib/*": ["src/lib/*"] },
      },
      include: ["src"],
    }),
    "src/lib/x.ts": 'export const x = "from lib";\n',
    "mid/tsconfig.json": "{ not json",
    "mid/scripts/dep.ts": 'export const dep = "dep-ok";\n',
    "mid/scripts/seed.ts": seed,
  });
  const aliased = createProject(
    project('import { x } from "@lib/x.ts";\nconsole.log("aliased:" + x);\n'),
  );
  try {
    const ran = runWithHooks(join(aliased, "mid", "scripts"), "./seed.ts");
    expect(ran.status, "the walk must stop at the broken config").not.toBe(0);
    expect(ran.stderr, "the alias must not resolve past the broken config").toContain(
      "ERR_MODULE_NOT_FOUND",
    );
  } finally {
    rmSync(aliased, { recursive: true, force: true });
  }

  const relative = createProject(
    project('import { dep } from "./dep.js";\nconsole.log("relative:" + dep);\n'),
  );
  try {
    const ran = runWithHooks(join(relative, "mid", "scripts"), "./seed.ts");
    expect(ran.stderr, "a broken nearest config should only cost the aliases").toMatch(
      warning(join(relative, "mid", "tsconfig.json"), "ignoring it"),
    );
    expect(ran.stdout.trim(), "relative resolution needs no config").toBe("relative:dep-ok");
  } finally {
    rmSync(relative, { recursive: true, force: true });
  }
});

// A malformed nearest config must not stay poisoned for the process:
// discovery's own cache retries parse failures (`get_or_try_init` caches no
// error), so a corrected config — still not claiming the importer — must
// apply its `paths` to the next resolution in the same process.
test("a malformed nearest tsconfig can be corrected mid-process", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": "{ not json",
    "src/lib/x.ts": 'export const x = "from lib";\n',
  });
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts", "seed.ts"),
    `const attempt = async (label) => {
  try {
    await import("@lib/x.ts");
    console.log(label + ":resolved");
  } catch {
    console.log(label + ":failed");
  }
};
await attempt("first");
const { writeFileSync } = await import("node:fs");
writeFileSync(
  new URL("../tsconfig.json", import.meta.url),
  JSON.stringify({
    compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
    include: ["src"],
  }),
);
await attempt("second");
`,
  );
  try {
    const ran = runWithHooks(join(root, "scripts"), "./seed.ts");
    expect(ran.stderr, "both imports are caught; only the warning reaches stderr").toMatch(
      warning(join(root, "tsconfig.json"), "ignoring it"),
    );
    expect(ran.stdout.trim().split("\n"), "a corrected config must be picked up").toEqual([
      "first:failed",
      "second:resolved",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The transform API takes a path and a working directory, and nothing says the
// path has to be absolute — the sibling `index.spec.ts` passes `"foo.ts"`.
// Discovery only accepts absolute paths, so a relative one has to be joined
// against the transformer's own `cwd` before the lookup.
const RELATIVE_VS_ABSOLUTE = `import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OxcTransformer } from "@oxc-node/core";
const source = readFileSync("entry.ts", "utf8");
const transformer = new OxcTransformer(process.cwd());
const applied = (path) => transformer.transform(path, source).source().includes("_decorate");
console.log("relative:" + applied("entry.ts"));
console.log("absolute:" + applied(resolve("entry.ts")));
`;

test("a relative path into the transform API finds the same tsconfig as an absolute one", () => {
  const root = createProject({
    "tsconfig.json": DECORATORS_TSCONFIG,
    "entry.ts": DECORATED,
    "relative-vs-absolute.mjs": RELATIVE_VS_ABSOLUTE,
  });
  try {
    const ran = runNode(root, [join(root, "relative-vs-absolute.mjs")]);
    expect(ran.stderr, "the driver should not fail").toBe("");
    expect(ran.stdout.trim().split("\n"), "both spellings must get the option").toEqual([
      "relative:true",
      "absolute:true",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Node hands the hooks percent-encoded URLs, so a directory name with a space
// or a non-ASCII character reaches us as `My%20Pr%C3%B5ject`. Slicing off the
// `file://` scheme without decoding names a directory that does not exist.
test("a project directory with a space and non-ASCII characters still resolves", () => {
  const project = "My Prõject";
  const files = (dir: string) => ({
    [`${dir}/package.json`]: JSON.stringify({ type: "module" }),
    [`${dir}/tsconfig.json`]: JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        experimentalDecorators: true,
        paths: { "@sub/*": ["./src/subdirectory/*"] },
      },
      include: ["src"],
    }),
    [`${dir}/src/subdirectory/bar.mts`]: 'export const bar = () => "bar";\n',
    [`${dir}/src/entry.ts`]:
      'import { bar } from "@sub/bar.mts";\nconsole.log("alias:" + bar());\n',
    [`${dir}/src/decorated.ts`]: DECORATED,
  });
  const root = createProject({ ...files(project), ...files("plain") });
  try {
    // The ASCII-named copy is the control: both must behave identically.
    for (const dir of [project, "plain"]) {
      const source = join(root, dir, "src");

      const ran = runWithHooks(source, "./entry.ts");
      expect(ran.stderr, `${dir}: the paths alias should resolve`).toBe("");
      expect(ran.stdout.trim(), `${dir}: the paths alias should resolve`).toBe("alias:bar");

      const emitted = emit(root, source, "./decorated.ts");
      expect(emitted.stdout, `${dir}: compiler options should apply`).toContain("_decorate");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Issue #844: a tsconfig that cannot be used is reported once on stderr
// instead of being dropped without a word, and the run goes on without it.
test("a missing OXC_TSCONFIG_PATH is reported", () => {
  const root = createProject({ "tsconfig.json": DECORATORS_TSCONFIG, "entry.ts": DECORATED });
  try {
    const emitted = emit(root, root, "./entry.ts", {
      OXC_TSCONFIG_PATH: join(root, "does-not-exist.json"),
    });
    expect(emitted.stderr, "the missing config must be reported").toContain(
      `oxc-node: warning: the tsconfig OXC_TSCONFIG_PATH names, ${join(root, "does-not-exist.json")}, does not exist; running without a tsconfig`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit tsconfig that cannot be parsed is reported", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "broken.json": "{ not json",
    "a.ts": 'export const a = "ran";\n',
    // `./a.js` -> `a.ts` needs oxc-node's own resolver, which must still work.
    "entry.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
  });
  try {
    const ran = runWithHooks(root, "./entry.ts", { TS_NODE_PROJECT: join(root, "broken.json") });
    expect(ran.stderr, "the broken config must be reported once").toMatch(
      warning(join(root, "broken.json"), "running without a tsconfig"),
    );
    expect(ran.stdout.trim(), "the run goes on without the config").toBe("ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a discovered tsconfig that cannot be parsed is reported once per process", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": "{ not json",
    "a.ts": 'export const a = "a";\n',
    "b.ts": 'export const b = "b";\n',
    "entry.ts": 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nconsole.log(a + b);\n',
  });
  try {
    const ran = runWithHooks(root, "./entry.ts");
    expect(ran.stderr, "three files share the config; it is reported once").toMatch(
      warning(join(root, "tsconfig.json"), "ignoring it"),
    );
    expect(ran.stdout.trim(), "the run goes on without the config").toBe("ab");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tsconfig that extends a missing file is reported", () => {
  const root = createProject({
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({ extends: "./missing-base.json" }),
    "entry.ts": 'console.log("ran");\n',
  });
  try {
    const ran = runWithHooks(root, "./entry.ts");
    expect(ran.stderr, "the missing base must be named").toMatch(
      new RegExp(
        `^oxc-node: warning: the tsconfig (/private)?${escapeRegExp(join(root, "missing-base.json"))}, which a tsconfig extends or references, does not exist; ignoring it$`,
      ),
    );
    expect(ran.stdout.trim(), "the run goes on without the config").toBe("ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Discovery skips a tsconfig it cannot open and walks on to a grandparent
// without returning an error, so the skip is reported on its own. Mode bits
// stop neither root nor Windows from reading the file.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable discovered tsconfig is reported as skipped",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
      }),
      "lib/x.ts": 'export const x = "from lib";\n',
      "sub/tsconfig.json": "{}",
      "sub/entry.ts": 'import { x } from "@lib/x.ts";\nconsole.log(x);\n',
    });
    chmodSync(join(root, "sub", "tsconfig.json"), 0o000);
    try {
      const ran = runWithHooks(join(root, "sub"), "./entry.ts");
      expect(ran.stderr, "the unreadable config must be reported once").toMatch(
        warning(join(root, "sub", "tsconfig.json"), "skipping it"),
      );
      expect(ran.stdout.trim(), "discovery walks on to the root config").toBe("from lib");
    } finally {
      chmodSync(join(root, "sub", "tsconfig.json"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// A readable config that does not claim the file does not stop discovery, so
// an unreadable one above it is still walked past and must still be reported.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable tsconfig above a config that does not claim the file is reported",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
      }),
      "lib/x.ts": 'export const x = "from lib";\n',
      "mid/tsconfig.json": "{}",
      "mid/sub/tsconfig.json": JSON.stringify({ include: ["other"] }),
      "mid/sub/entry.ts": 'import { x } from "@lib/x.ts";\nconsole.log(x);\n',
    });
    chmodSync(join(root, "mid", "tsconfig.json"), 0o000);
    try {
      const ran = runWithHooks(join(root, "mid", "sub"), "./entry.ts");
      expect(ran.stderr, "the unreadable config must be reported once").toMatch(
        warning(join(root, "mid", "tsconfig.json"), "skipping it"),
      );
      expect(ran.stdout.trim(), "discovery walks on to the root config").toBe("from lib");
    } finally {
      chmodSync(join(root, "mid", "tsconfig.json"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// A config behind a directory that may not be searched may well exist; saying
// it does not would send the user looking for a typo.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an explicit tsconfig that cannot be checked is reported as unreadable",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "locked/tsconfig.json": "{}",
      "entry.ts": 'console.log("ran");\n',
    });
    const config = join(root, "locked", "tsconfig.json");
    chmodSync(join(root, "locked"), 0o000);
    try {
      const ran = runWithHooks(root, "./entry.ts", { TS_NODE_PROJECT: config });
      expect(ran.stderr, "the config must be reported as unreadable, once").toMatch(
        new RegExp(
          `^oxc-node: warning: failed to read the tsconfig TS_NODE_PROJECT names, ${escapeRegExp(config)}: [^\\n]+; running without a tsconfig$`,
        ),
      );
      expect(ran.stdout.trim(), "the run goes on without the config").toBe("ran");
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// A missing `references` target fails the lookup without naming the config it
// failed on; the unreadable config the walk skipped first must still be named.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable tsconfig below a config with a missing reference is reported",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({ references: [{ path: "./missing" }] }),
      "sub/tsconfig.json": "{}",
      "sub/entry.ts": 'console.log("ran");\n',
    });
    chmodSync(join(root, "sub", "tsconfig.json"), 0o000);
    try {
      const ran = runWithHooks(join(root, "sub"), "./entry.ts");
      expect(ran.stderr, "the skipped config must be reported").toMatch(
        new RegExp(
          `^oxc-node: warning: failed to read the tsconfig (/private)?${escapeRegExp(join(root, "sub", "tsconfig.json"))}: [^\\n]+; skipping it$`,
          "m",
        ),
      );
      expect(ran.stderr, "so must the missing reference").toContain(
        "which a tsconfig extends or references, does not exist; ignoring it",
      );
      expect(ran.stdout.trim(), "the run goes on without a config").toBe("ran");
    } finally {
      chmodSync(join(root, "sub", "tsconfig.json"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Discovery reads `?` as the start of a query and walks up from the truncated
// path, so it never sees a config in the directory named `q?x`; reporting that
// config as skipped would be wrong.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable tsconfig discovery never reached is not reported",
  () => {
    const root = createProject({
      "q?x/tsconfig.json": "{}",
      "q?x/entry.ts": "export const x: number = 1;\n",
    });
    chmodSync(join(root, "q?x", "tsconfig.json"), 0o000);
    try {
      const emitted = emit(root, root, "./q?x/entry.ts");
      expect(emitted.stderr, "nothing was skipped, so nothing is reported").toBe("");
    } finally {
      chmodSync(join(root, "q?x", "tsconfig.json"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// The resolver takes a `tsconfig.json` whose metadata cannot be read, here a
// symlink into a directory that may not be searched, for "not a file" and
// walks on; that is a skipped config too.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a tsconfig symlinked into an unsearchable directory is reported as skipped",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
      }),
      "lib/x.ts": 'export const x = "from lib";\n',
      "locked/real.json": "{}",
      "sub/entry.ts": 'import { x } from "@lib/x.ts";\nconsole.log(x);\n',
    });
    symlinkSync(join(root, "locked", "real.json"), join(root, "sub", "tsconfig.json"));
    chmodSync(join(root, "locked"), 0o000);
    try {
      const ran = runWithHooks(join(root, "sub"), "./entry.ts");
      expect(ran.stderr, "the unreachable config must be reported once").toMatch(
        warning(join(root, "sub", "tsconfig.json"), "skipping it"),
      );
      expect(ran.stdout.trim(), "discovery walks on to the root config").toBe("from lib");
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// A failed lookup stops at the config that failed; a readable config below it
// that does not claim the file was walked past, and so was the unreadable one
// between them.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable tsconfig between a non-owning config and a failing one is reported",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({ references: [{ path: "./missing" }] }),
      "mid/tsconfig.json": "{}",
      "mid/sub/tsconfig.json": JSON.stringify({ include: ["other"] }),
      "mid/sub/entry.ts": 'console.log("ran");\n',
    });
    chmodSync(join(root, "mid", "tsconfig.json"), 0o000);
    try {
      const ran = runWithHooks(join(root, "mid", "sub"), "./entry.ts");
      expect(ran.stderr, "the skipped config must be reported").toMatch(
        new RegExp(
          `^oxc-node: warning: failed to read the tsconfig (/private)?${escapeRegExp(join(root, "mid", "tsconfig.json"))}: [^\\n]+; skipping it$`,
          "m",
        ),
      );
      expect(ran.stderr, "so must the missing reference").toContain(
        "which a tsconfig extends or references, does not exist; ignoring it",
      );
      expect(ran.stdout.trim(), "the run goes on without a config").toBe("ran");
    } finally {
      chmodSync(join(root, "mid", "tsconfig.json"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// An importer under `q?x` goes unscanned (discovery walks from the truncated
// path), so a bare import reaches the nearest-ancestor fallback, which walks
// the real path and must report the symlinked config it skips just the same.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "the nearest-ancestor fallback reports a tsconfig it cannot look up",
  () => {
    const root = createProject({
      "package.json": JSON.stringify({ type: "module" }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
        include: ["lib"],
      }),
      "lib/x.ts": 'export const x = "from lib";\n',
      "locked/real.json": "{}",
      "q?x/entry.ts": 'import { x } from "@lib/x.ts";\nconsole.log(x);\n',
    });
    symlinkSync(join(root, "locked", "real.json"), join(root, "q?x", "tsconfig.json"));
    chmodSync(join(root, "locked"), 0o000);
    try {
      const ran = runWithHooks(join(root, "q?x"), "./entry.ts");
      expect(ran.stderr, "the unreachable config must be reported once").toMatch(
        warning(join(root, "q?x", "tsconfig.json"), "skipping it"),
      );
      expect(ran.stdout.trim(), "the fallback walks on to the root config").toBe("from lib");
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
