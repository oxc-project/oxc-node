// A package without `"type"`: `tsc` compiles this file to CommonJS, but Node.js' syntax
// detection runs it as an ES module, and so does oxc-node.
export const hasRequire = typeof require;
