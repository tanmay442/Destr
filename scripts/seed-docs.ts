import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export { parseSeedArgs as parseArgs } from '../packages/cli/src/commands/seed.js';
export type { SeedParseResult, SeedOptions } from '../packages/cli/src/commands/seed.js';

const { runSeed } = await import('../packages/cli/src/commands/seed.js');

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
  const { parseSeedArgs } = await import('../packages/cli/src/commands/seed.js');
  const { dir, userId } = parseSeedArgs(process.argv.slice(2));
  const absoluteDir = resolve(REPO_ROOT, dir);
  console.log(`Seeding PDFs from ${absoluteDir}`);
  await runSeed({ userId, fixturesDir: absoluteDir }).catch((err: unknown) => {
    console.error('seed failed:', err);
    process.exit(1);
  });
}
