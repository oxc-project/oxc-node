import { transform } from '@oxc-node/core'
import test from 'ava'

test('transform', (t) => {
  const result = transform('foo.ts', 'const foo: number = 1')
  t.is(result.source(), 'const foo = 1;\n')
})
