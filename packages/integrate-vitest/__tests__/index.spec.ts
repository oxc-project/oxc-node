import { OxcTransformer } from "@oxc-node/core";
import { expect, test } from "vite-plus/test";

test("transform", async () => {
  const transformer = new OxcTransformer(process.cwd());
  const result = await transformer.transformAsync("foo.ts", "const foo: number = 1");
  expect(result.source()).toBe('"use strict";\nconst foo = 1;\n');
});
