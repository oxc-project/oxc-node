import { OxcTransformer } from '@oxc-node/core'
import test from 'ava'

test('transform', async (t) => {
  const transformer = new OxcTransformer(process.cwd())
  const result = await transformer.transformAsync('foo.ts', 'const foo: number = 1')
  t.is(result.source(), '"use strict";\nconst foo = 1;\n')
})
