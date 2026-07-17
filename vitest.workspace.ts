const workspace = [
  {
    test: {
      name: 'app',
      include: ['src/**/*.{test,test-d}.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      globals: true,
      css: false,
    },
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
        'server-only': new URL('./vitest.shims/server-only.ts', import.meta.url).pathname,
      },
    },
  },
  {
    test: {
      name: 'packages',
      include: ['packages/**/*.{test,test-d}.{ts,tsx}'],
      environment: 'node',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
    },
  },
  {
    test: {
      name: 'scripts',
      include: ['scripts/**/*.test.{ts,tsx}'],
      environment: 'node',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
    },
  },
];

export default workspace;
