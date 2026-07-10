import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Fallback config; vitest.workspace.ts is primary. Keep in sync.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'src/**/*.{test,test-d}.{ts,tsx}',
      'scripts/**/*.{test,test-d}.{ts,tsx}',
      'packages/**/*.{test,test-d}.{ts,tsx}',
    ],
    exclude: ['e2e/**', 'node_modules/**', '.next/**', '**/node_modules/**'],
    globals: true,
    css: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './vitest.shims/server-only.ts'),
    },
  },
});
