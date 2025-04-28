import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import oxcRuntimePackageJson from '@oxc-project/runtime/package.json' with { type: 'json' }

import currentPackageJson from './package.json' with { type: 'json' }

const { resolve } = createRequire(import.meta.url)

const currentDir = join(resolve('.'), '..')

const oxcRuntimeDir = join(resolve('@oxc-project/runtime/package.json'), '..')

const files = await readdir(oxcRuntimeDir, { recursive: true })

await mkdir(join(currentDir, 'src', 'helpers', 'esm'), { recursive: true }).catch(() => {
  // ignore error
})

for (const file of files.filter((file) => file.endsWith('.js'))) {
  const filePath = join(oxcRuntimeDir, file)
  await copyFile(filePath, join(currentDir, file))
}

const packageJsonExports = {
  '.': {
    'import': './index.js',
    'require': './index.js',
    'types': './index.d.ts',
  },
  './esm': {
    'import': './esm.mjs',
  },
  './esm.mjs': {
    'import': './esm.mjs',
  },
  './register': {
    'import': './register.mjs',
  },
  './register.mjs': {
    'import': './register.mjs',
  },
  ...oxcRuntimePackageJson.exports,
}

await writeFile(
  join(currentDir, 'package.json'),
  JSON.stringify(
    {
      ...currentPackageJson,
      exports: packageJsonExports,
    },
    null,
    2,
  ),
)
