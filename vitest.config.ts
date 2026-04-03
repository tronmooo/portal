import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/schema.test.ts', 'tests/utils.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/full-suite.test.ts', 'tests/critical-flows.test.ts', 'tests/api-e2e.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
});
