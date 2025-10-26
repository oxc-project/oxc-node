import { expect } from 'vitest'

export interface LogsMatcher {
  logOutput: () => void
  should: {
    contain: (expected: string) => void
    not: {
      contain: (expected: string) => void
    }
  }
}

export function createLogsMatcher(output: string): LogsMatcher {
  return {
    logOutput: () => {
      console.log('=== CLI Output ===')
      console.log(output)
      console.log('=================')
    },
    should: {
      contain: (expected: string) => {
        expect(output).toContain(expected)
      },
      not: {
        contain: (expected: string) => {
          expect(output).not.toContain(expected)
        },
      },
    },
  }
}
