import test from 'ava'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SOURCE_MAP_SNIPPET = '//# sourceMappingURL=data:application/json'

type CompileFn = (this: unknown, source: string, filename: string) => unknown
const modulePrototype = Module.prototype as unknown as { _compile: CompileFn }

const registerPromise = import('@oxc-node/core/register')

test('register hook adds inline source maps for TypeScript modules', async (t) => {
  await registerPromise
  const fixtureUrl = new URL('./fixtures/source-map-fixture.ts', import.meta.url)
  const fixturePath = fileURLToPath(fixtureUrl)
  const resolvedFixture = require.resolve(fixturePath)

  delete require.cache[resolvedFixture]

  const originalCompile = modulePrototype._compile
  let compiledSource: string | undefined

  modulePrototype._compile = function patchedCompile(source: string, filename: string) {
    if (filename === resolvedFixture) {
      compiledSource = source
    }

    return originalCompile.call(this, source, filename)
  }

  try {
    require(fixturePath)
  } finally {
    modulePrototype._compile = originalCompile
    delete require.cache[resolvedFixture]
  }

  t.truthy(compiledSource, 'fixture should compile under the register hook')
  t.true(
    compiledSource?.includes(SOURCE_MAP_SNIPPET),
    'inline source map data URL should be appended to transformed output',
  )
})
