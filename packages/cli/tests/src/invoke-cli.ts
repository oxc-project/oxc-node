import { execaSync } from 'execa'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'
import { createLogsMatcher, type LogsMatcher } from './matchers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Path to the built CLI binary
const CLI_PATH = path.resolve(__dirname, '../../../cli/dist/index.js')

export interface OxnodeCLI {
  invoke: (args: string[]) => [number, LogsMatcher]
  setCwd: (cwd: string) => OxnodeCLI
}

export function OxnodeCLI(): OxnodeCLI {
  let workingDirectory = process.cwd()

  const setCwd = (cwd: string): OxnodeCLI => {
    workingDirectory = cwd
    return api
  }

  const invoke = (args: string[]): [number, LogsMatcher] => {
    try {
      const result = execaSync('node', [CLI_PATH, ...args], {
        cwd: workingDirectory,
        env: {
          ...process.env,
          NODE_ENV: 'production',
        },
        all: true,
        reject: false,
      })

      const output = stripAnsi(result.all || '')
      const exitCode = result.exitCode

      return [exitCode, createLogsMatcher(output)]
    } catch (error) {
      // If execa throws an error, capture it
      const err = error as { all?: string; exitCode?: number }
      const output = stripAnsi(err.all || '')
      const exitCode = err.exitCode || 1

      return [exitCode, createLogsMatcher(output)]
    }
  }

  const api: OxnodeCLI = {
    invoke,
    setCwd,
  }

  return api
}
