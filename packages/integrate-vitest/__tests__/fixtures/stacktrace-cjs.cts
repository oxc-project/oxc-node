const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("stacktrace cts", () => {
  it("should preserve stack trace", () => {
    assert.ok(false);
  });
});
