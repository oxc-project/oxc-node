// Test that oxnode can execute TypeScript files directly
const message: string = '!__E2E_OK__!'

interface TestResult {
  success: boolean
  value: number
}

const result: TestResult = {
  success: true,
  value: 42,
} as const

if (result.success) {
  console.log(message)
}
