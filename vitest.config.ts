import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      'src/**/*.test.tsx',
      'scripts/**/*.test.js',
      'examples/**/*.test.js',
    ],
    exclude: ['**/node_modules/**', 'node_modules', 'dist', 'release-build'],
    // Use jsdom for React component tests
    environmentMatchGlobs: [
      ['src/renderer/**/*.test.tsx', 'jsdom'],
      ['src/__tests__/*.test.tsx', 'jsdom'],
    ],
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/renderer/**/*',
        'src/preload/**/*',
      ]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
