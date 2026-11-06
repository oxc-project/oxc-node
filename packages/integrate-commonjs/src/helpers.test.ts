import assert from "node:assert/strict";
import test from "node:test";

// Legacy decorators compile to calls of oxc-node's runtime helpers, which this file,
// an entry point compiled to CommonJS, has to `require()`.
const decorated: string[] = [];

function record(_target: object, key: string): void {
  decorated.push(key);
}

class Service {
  @record
  run(): string {
    return "ran";
  }
}

void test("a file compiled to CommonJS can use the runtime helpers", () => {
  assert.deepEqual(decorated, ["run"]);
  assert.equal(new Service().run(), "ran");
});
