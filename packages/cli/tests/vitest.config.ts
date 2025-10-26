import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    forceRerunTriggers: [
      '**/packages/cli/dist/**',
      '**/node_modules/@oxc-node/cli/dist/**',
    ],
  },
})
