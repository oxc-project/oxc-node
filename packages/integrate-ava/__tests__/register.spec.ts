import test, { ExecutionContext } from 'ava'
import { spawnSync } from 'node:child_process'
import Module, { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

type CompileFn = (this: unknown, source: string, filename: string) => unknown

const require = createRequire(import.meta.url)
const SOURCE_MAP_SNIPPET = '//# sourceMappingURL=data:application/json'
const STACKTRACE_LINE = 6
const STACKTRACE_COLUMN = 12
const modulePrototype = Module.prototype as unknown as { _compile: CompileFn }
const FIXTURE_PATHS = new Map(
  [
    'source-map-fixture.ts',
    'stacktrace-esm.ts',
    'stacktrace-esm.mts',
    'stacktrace-cjs.cts',
  ].map((name) => [name, fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))]),
)
// @ts-expect-error Module shipped without TypeScript declarations
const registerPromise = import('@oxc-node/core/register')
const getFixturePath = (fixtureName: string) => {
  const resolved = FIXTURE_PATHS.get(fixtureName)
  if (!resolved) {
    throw new Error(`Unknown fixture: ${fixtureName}`)
  }
  return resolved
}
const captureTransformedSource = async (fixtureName: string) => {
  await registerPromise
  const fixturePath = getFixturePath(fixtureName)
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

  return compiledSource
}

test('register hook adds inline source maps for TypeScript modules', async (t) => {
  const compiledSource = await captureTransformedSource('source-map-fixture.ts')

  t.truthy(compiledSource, 'fixture should compile under the register hook')
  t.true(
    compiledSource?.includes(SOURCE_MAP_SNIPPET),
    'inline source map data URL should be appended to transformed output',
  )
})

const runFixture = (loaderSpecifier: string, fixtureName: string) => {
  const fixturePath = getFixturePath(fixtureName)
  const result = spawnSync(process.execPath, ['--import', loaderSpecifier, '--test', fixturePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
    },
  })

  return { ...result, fixturePath }
}
// Fixture paths can contain characters (space, +, parentheses) that have special meaning in regexes,
// so escape them before embedding the path in a dynamic pattern.
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')
const expectStackLocation = (t: ExecutionContext, output: string, fixturePath: string) => {
  const fileUrl = pathToFileURL(fixturePath).href
  const pattern = new RegExp(`(?:${escapeRegExp(fileUrl)}|${escapeRegExp(fixturePath)}):(\\d+):(\\d+)`)
  const match = pattern.exec(output)

  t.truthy(match, 'stack trace should reference the failing fixture path')

  if (match) {
    const [, line, column] = match
    t.is(Number(line), STACKTRACE_LINE)
    t.is(Number(column), STACKTRACE_COLUMN)
  }
}
const stackTraceVariants: Array<{ loader: string; fixture: string }> = [
  ...['stacktrace-esm.ts', 'stacktrace-esm.mts', 'stacktrace-cjs.cts'].map((fixture) => ({
    loader: '@oxc-node/core/register',
    fixture,
  })),
  // The ESM loader is not officially documented but ships today, so we keep a smoke test
  // to track regressions for consumers using Node's --loader entry point directly.
  {
    loader: '@oxc-node/core/esm',
    fixture: 'stacktrace-esm.ts',
  },
]

for (const variant of stackTraceVariants) {
  test(`stack trace for ${variant.fixture} via ${variant.loader}`, (t) => {
    const { stdout, stderr, status, error, fixturePath } = runFixture(variant.loader, variant.fixture)

    t.falsy(error, error?.message)
    t.not(status, 0, 'fixture should fail to trigger stack trace output')

    const combinedOutput = `${stdout}${stderr}`
    expectStackLocation(t, combinedOutput, fixturePath)
  })
}
