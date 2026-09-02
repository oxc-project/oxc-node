import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const CORE_PATH = fileURLToPath(new URL("../../core", import.meta.url));

// A legacy (`experimentalDecorators`) decorator is emitted through the
// `_decorate` helper and is called with (target, key, descriptor). Without the
// option the decorator is left in the output untouched, so both the emitted
// code and the runtime behaviour tell the two apart.
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
    expect(excluded.stdout, "sub/ is outside include, so no config applies").not.toContain(
      "_decorate",
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
    expect(ran.stderr, "resolution should not fail").toBe("");
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
    expect(
      emitted.stdout,
      "an explicit missing config must not fall back to discovery",
    ).not.toContain("_decorate");
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

test("the JavaScript probe does not resurrect a config that excludes the directory", () => {
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
    // `exclude` must win for JavaScript exactly as it does for TypeScript.
    for (const entry of ["./from-mjs.mjs", "./from-ts.ts"]) {
      const ran = runWithHooks(join(root, "src", "excluded"), entry);
      expect(ran.status, `${entry} is excluded, so the alias must not resolve`).not.toBe(0);
      expect(ran.stderr, `${entry} is excluded, so the alias must not resolve`).toContain(
        "ERR_MODULE_NOT_FOUND",
      );
    }
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
