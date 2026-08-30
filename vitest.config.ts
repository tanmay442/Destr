import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [],
    exclude: ['e2e/**', 'node_modules/**', '.next/**', '**/node_modules/**'],
    globals: true,
    css: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'scripts/**/*.{test,test-d}.{ts,tsx}',
            'packages/**/*.{test,test-d}.{ts,tsx}',
            'src/app/api/**/*.{test,test-d}.{ts,tsx}',
            'src/app/(app)/admin/actions.{test,test-d}.{ts,tsx}',
            'src/lib/**/*.{test,test-d}.{ts,tsx}',
            'src/chat/**/*.{test,test-d}.{ts,tsx}',
            'src/__tests__/**/*.{test,test-d}.{ts,tsx}',
            'src/proxy.{test,test-d}.{ts,tsx}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: [
            'src/components/**/*.{test,test-d}.{ts,tsx}',
            'src/app/(app)/admin/settings/settings-client.{test,test-d}.{ts,tsx}',
          ],
        },
      },
    ],
  },
  resolve: {
    dedupe: ['drizzle-orm'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './vitest.shims/server-only.ts'),
    },
  },
});
