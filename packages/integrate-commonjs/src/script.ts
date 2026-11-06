// Without `import` or `export` this file is CommonJS, as `tsc` compiles it, also when
// an ES module asks for it.
module.exports = { hasRequire: typeof require };
