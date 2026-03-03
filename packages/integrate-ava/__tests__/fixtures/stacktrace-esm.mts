import assert from "node:assert/strict";
import { describe, it } from "node:test";

void describe("stacktrace esm mts", () => {
  void it("should preserve stack trace", () => {
    assert.ok(false);
  });
});
