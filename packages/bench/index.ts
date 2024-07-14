import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from '@swc/core'
import { transform as oxc } from '@oxc-node/core'
import { Bench } from 'tinybench'
import ts from 'typescript'

const bench = new Bench({ time: 1000 })

const fixture = (
  await readFile(join(fileURLToPath(import.meta.url), '..', 'node_modules/rxjs/src/internal/ajax/ajax.ts'))
).toString('utf8')

bench
  .add('@swc/core', () => {
    transformSync(fixture, {
      filename: 'ajax.ts',
      jsc: {
        target: 'esnext',
        parser: {
          syntax: 'typescript',
          tsx: false,
          dynamicImport: false,
          decorators: false,
        },
      },
    })
  })
  .add('oxc', () => {
    oxc('ajax.ts', fixture)
  })
  .add('typescript', () => {
    ts.transpileModule(fixture, {
      fileName: 'ajax.ts',
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
        sourceMap: true,
      },
    })
  })

await bench.warmup() // make results more reliable, ref: https://github.com/tinylibs/tinybench/pull/50
await bench.run()

console.table(bench.table())
