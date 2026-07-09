// Test shim: re-exports the CLI seed command; run as program root it delegates to it.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export { parseSeedArgs as parseArgs, runSeed } from '../packages/cli/src/commands/seed.js';
export type { SeedParseResult, SeedOptions } from '../packages/cli/src/commands/seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    /* .env.local may not exist */
  }
  const seedMod = await import('../packages/cli/src/commands/seed.js');
  const { dir, userId } = seedMod.parseSeedArgs(process.argv.slice(2));
  const CLI = resolve(REPO_ROOT, 'packages/cli/src/index.ts');
  const result = spawnSync('pnpm', ['exec', 'tsx', CLI, 'seed'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, SEED_DOCS_DIR: dir, ...(userId ? { SEED_USER_ID: userId } : {}) },
  });
  process.exit(result.status ?? 0);
}
