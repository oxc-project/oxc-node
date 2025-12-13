import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("stacktrace esm ts", () => {
  it("should preserve stack trace", () => {
    assert.ok(false);
  });
});
