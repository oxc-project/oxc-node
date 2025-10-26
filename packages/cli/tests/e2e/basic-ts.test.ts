import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OxnodeCLI } from '../src/invoke-cli.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(__dirname, '../e2e-fixtures/basic-ts')

describe('basic-ts fixture', () => {
  it('should execute TypeScript file directly', () => {
    const [exitCode, logs] = OxnodeCLI()
      .setCwd(FIXTURE_PATH)
      .invoke(['index.ts'])

    expect(exitCode).toBe(0)
    logs.should.contain('!__E2E_OK__!')
  })
})
