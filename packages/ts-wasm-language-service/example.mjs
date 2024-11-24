import { readFile } from 'node:fs/promises'

import { getTypesFromWasm } from './index.js'

const wasm = await readFile(
  import.meta.dirname + '/node_modules/@rollup/wasm-node/dist/wasm-node/bindings_wasm_bg.wasm',
)

console.log(getTypesFromWasm(wasm))
