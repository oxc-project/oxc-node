import { register } from 'node:module'

import { addHook } from 'pirates'

import { OxcTransformer } from './index.js'

const DEFAULT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts', '.es6', '.es'])

register('@oxc-node/core/esm', import.meta.url)

const transformer = new OxcTransformer(process.cwd())

addHook(
  (code, filename) => {
    return transformer.transform(filename, code).source()
  },
  {
    ext: Array.from(DEFAULT_EXTENSIONS),
  },
)
