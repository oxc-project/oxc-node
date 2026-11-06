// An ES module importing the compiled CommonJS: its named exports come from
// `cjs-module-lexer`, which reads them from the compiled source.
export { compute } from "./lib.js";
export { answer } from "./app.js";
// Its default export is `module.exports`, as for any CommonJS module.
export { default as libDefault } from "./lib.js";
