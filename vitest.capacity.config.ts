import { defineConfig } from 'vitest/config';

/**
 * WP-8 §13.6 capacity gate runner config.
 *
 * Synthetic capacity/load simulations live here, not in the default unit
 * suite (`vitest.config.ts` excludes `scripts/load/**`): they run real
 * multi-thousand-turn simulations whose CPU would otherwise starve
 * timing-sensitive suites on shared runners. `pnpm test:capacity` runs the
 * CLI gate plus this config, so nothing is skipped.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    environment: 'node',
    include: ['scripts/load/**/*.{test,test-d}.{ts,tsx}'],
  },
});
