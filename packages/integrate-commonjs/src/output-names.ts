// Imports named by their output, as `nodenext` has them written: compiled to
// CommonJS, each is a `require()` of a file that only exists as TypeScript.
export { compute } from "./lib.js";
export { esmValue } from "./esm-lib.mjs";
