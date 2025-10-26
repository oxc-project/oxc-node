import { describe, expect, it } from 'vitest'
import { OxnodeCLI } from '../src/invoke-cli.js'

describe('oxnode CLI', () => {
  it('should show help when --help flag is passed', () => {
    const [exitCode, logs] = OxnodeCLI().invoke(['--help'])

    expect(exitCode).toBe(0)
    logs.should.contain('oxnode')
    logs.should.contain('Run a script with oxc transformer and oxc-resolver')
  })

  it('should show version when --version flag is passed', () => {
    const [exitCode, logs] = OxnodeCLI().invoke(['--version'])

    expect(exitCode).toBe(0)
    logs.should.contain('0.0.')
  })
})
