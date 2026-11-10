import assert from "node:assert/strict";
import test from "node:test";

import legacyDefault, { legacy } from "./legacy.cjs";
import Greeter, * as lib from "./lib";
import { answer, doubled, time } from "./app";
import { aliased } from "@alias/value";
import { readB, seenDuringLoad } from "./cycle-a";
import { parent } from "./barrel/inner/use";
import * as cycle from "./cycle-c";
import { fourth, second, tagged } from "./declarators";
import * as Klass from "./klass.cjs";
import { compute, esmValue } from "./output-names";
import { where as shadowedByOutputName } from "./shadowed.js";
import { where as shadowedExtensionless } from "./shadowed";
import { fail } from "./throws";
import { widget } from "./widget.js";

// `tsc` compiles ES module syntax in a `"type": "commonjs"` package to CommonJS when
// tsconfig's `module` is `nodenext`, and so does oxc-node.
void test("runs as CommonJS", () => {
  assert.equal(typeof module, "object");
  assert.equal(typeof require, "function");
  assert.equal(require("./lib"), lib);
});

void test("a namespace export can be mocked, and importers see the mock", (t) => {
  t.mock.method(lib, "compute", (n: number) => n * 2);
  assert.equal(answer(), 82);
});

// A function declaration is exported before the module body runs, a class after its
// declaration; both are plain properties all the same.
void test("a function declaration export can be mocked, and importers see the mock", (t) => {
  t.mock.method(lib, "twice", (n: number) => n * 3);
  assert.equal(doubled(), 63);
});

void test("a class export can be replaced, and importers see the replacement", (t) => {
  class FakeClock extends lib.Clock {
    override now(): number {
      return 2;
    }
  }
  t.mock.property(lib, "Clock", FakeClock);
  assert.equal(time(), 2);
});

void test("a reassigned export stays live", () => {
  assert.equal(lib.counter, 0);
  lib.increment();
  assert.equal(lib.counter, 1);
});

void test("default, star and CommonJS imports", () => {
  assert.equal(new Greeter().greet(), "hello");
  assert.equal(lib.more, "more");
  assert.deepEqual(legacyDefault, { legacy: "legacy" });
  assert.equal(legacy, "legacy");
});

void test("imports named by their output find the TypeScript file", () => {
  assert.equal(compute, lib.compute);
  assert.equal(esmValue, "esm");
});

// `shadowed.js` is stale output of `shadowed.ts`. A TypeScript importer resolves
// TypeScript first (#840), whether it runs as an ES module or compiled to CommonJS.
void test("a TypeScript file is found before compiled output next to it", () => {
  assert.equal(shadowedByOutputName, "shadowed.ts");
  assert.equal(shadowedExtensionless, "shadowed.ts");
});

void test("`..` finds the TypeScript file before compiled output next to it", () => {
  assert.equal(parent, "barrel/index.ts");
});

void test("an import cycle sees an export from an earlier declarator", () => {
  assert.equal(second, 1);
  assert.equal(fourth, 3);
});

// `tsc` calls a tag as `(0, exports.tag)`, without `exports` as `this`.
void test("a reassigned export used as a template tag gets no receiver", () => {
  assert.equal(tagged, "unbound");
});

void test("an ES module importer gets the named exports", async () => {
  const esm = await import("./esm-importer.mjs");
  assert.equal(esm.compute(1), 2);
  assert.equal(esm.answer(), 42);
});

// Node.js gives an ES module `module.exports` as a CommonJS module's default export,
// `__esModule` or not, so the default export of the source is a property of it.
void test("an ES module importer's default import is the exports object", async () => {
  const esm = await import("./esm-importer.mjs");
  assert.equal(esm.libDefault, lib);
  assert.equal(esm.libDefault.default, Greeter);
});

// The tsconfig's `module` is `nodenext`, which leaves the format to `package.json`.
void test("a file without module syntax is CommonJS, also when an ES module asks for it", async () => {
  // Not literals: a file without module syntax gives TypeScript no module to type.
  for (const specifier of ["./script.js", "./untyped/script.js"]) {
    const script = await import(specifier);
    assert.deepEqual(script.default, { hasRequire: "function" }, specifier);
  }
  // Module syntax in a package without `"type"` runs as an ES module, as before.
  const untyped = await import("./untyped/module.js");
  assert.equal(untyped.hasRequire, "undefined");
});

// `cycle-b` runs while `cycle-a` is loading: as under `tsc`, the function declarations
// of `cycle-a` are exported already, and its other exports not yet.
void test("an import cycle sees what tsc's output sees", () => {
  assert.deepEqual(seenDuringLoad, { hoisted: "hoisted", late: undefined });
  assert.equal(readB(), "b");
});

// `cycle-d` reads `cycle-c` while it is loading: a reassigned `let`, a decorated class, a
// namespace and a re-export are `undefined` then, as under `tsc`, not a TDZ error, and
// the anonymous default function is declared already.
void test("an import cycle reads what is not set yet as undefined", () => {
  assert.deepEqual(cycle.seen, {
    counter: undefined,
    service: undefined,
    settings: undefined,
    reexported: undefined,
    anonymous: "anonymous default",
  });
  assert.equal(cycle.reexported, "more");
  assert.equal(cycle.Settings.level, 1);
});

// A reassigned `let` and a decorated class are plain data properties, as `tsc` emits
// them: live for every importer, and writable, so a test can replace them.
void test("a reassigned export stays live and can be replaced", () => {
  assert.equal(cycle.counter, 0);
  assert.equal(cycle.bump(), 1);
  assert.equal(cycle.counter, 1);
  for (const name of ["counter", "Service", "Settings"]) {
    assert.equal(Object.getOwnPropertyDescriptor(cycle, name)?.writable, true, name);
  }
});

void test("a namespace import of a CommonJS class keeps its static members", () => {
  assert.equal(Klass.create(), "created");
});

// With `allowJs`, `tsc` resolves `./widget.js` to `widget.jsx`, and `require()` finds it
// when no `widget.js` exists.
void test("an import named by its output finds a JSX file", () => {
  assert.equal(widget, "widget.jsx");
});

void test("a tsconfig `paths` alias resolves in a file compiled to CommonJS", () => {
  assert.equal(aliased, "aliased");
});

void test("a stack trace reports the TypeScript file's own lines", () => {
  assert.throws(fail, (error: Error) => /throws\.ts:5:9\)/.test(error.stack ?? ""));
});

void test("a module using import.meta or top-level await stays an ES module", async () => {
  const meta = await import("./meta.js");
  assert.match(meta.url, /^file:.*meta\.ts$/);
  const tla = await import("./tla.js");
  assert.equal(tla.answer, 42);
});
