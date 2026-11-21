import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // `npm run test:coverage` (vitest run --coverage). Only read when --coverage is passed, so plain `vitest run` is
    // unchanged. Needs the @vitest/coverage-v8 dev dependency at the installed vitest's version (not yet in
    // package.json / package-lock.json: add it with `npm install -D @vitest/coverage-v8@<vitest version>`).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.fixture.*', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
