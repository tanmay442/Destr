import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  makeRl,
  askYesNo,
} from '../../prompts/index';
import {
  writeOutputs,
  runConfigPrompts,
  validateConfig,
} from '../init';
import {
  banner,
  ok,
  warn,
  fail,
  loadCurrentDefaults,
} from '../common';
import {
  type AppConfig,
} from '@app/domain';
import {
  promptPrereqs,
  promptEnv,
  runMigration,
  verifyRag,
  printNextSteps,
} from './wizard';

export async function runSetup(repoRoot: string): Promise<void> {
  const CONFIG_PATH = join(repoRoot, 'config', 'app.config.ts');
  const ENV_PATH = join(repoRoot, '.env.local');

  console.log('\n\x1b[1mDestr — setup\x1b[0m');
  console.log('This wizard configures everything needed to run the Destr RAG knowledge agent.\n');

  if (!promptPrereqs(repoRoot)) {
    console.error('\nFix the issues above and re-run `pnpm configure`.');
    process.exit(1);
  }

  const rl = makeRl();
  await promptEnv(rl, ENV_PATH);

  banner('Migration');
  if (await askYesNo(rl, 'Run database migration now?', true)) {
    const success = runMigration(repoRoot);
    if (!success) {
      fail('Database migration failed. Stopping setup.');
      rl.close();
      process.exit(1);
    }
  } else {
    warn('Skipped migration. Run `pnpm cli db-migrate` later.');
  }

  banner('Configuration');
  console.log('Press Enter to keep the current value shown in [brackets].\n');

  const defaults = await loadCurrentDefaults(CONFIG_PATH);
  let config: AppConfig = defaults;

  let absSource = await runConfigPrompts(rl, config, repoRoot);

  const destDir = isAbsolute(config.seedDocsDir)
    ? config.seedDocsDir
    : resolve(repoRoot, config.seedDocsDir);

  if (!absSource || !existsSync(absSource) || readdirSync(absSource).length === 0) {
    absSource = '';
    warn('No PDFs found. You can upload documents later via /admin/upload.');
  }

  try {
    config = validateConfig(rl, config);
  } catch {
    process.exit(1);
  }

  banner('Writing outputs');
  const result = await writeOutputs({
    repoRoot,
    configPath: CONFIG_PATH,
    envPath: ENV_PATH,
    config,
    absSource,
    destDir,
    rl,
  });


  if (!result.ranSeed) {
    if (result.copied.length > 0) {
      warn(`Seed skipped: ${result.seedReason ?? 'unknown'}`);
      const seedAgain = spawnSync('pnpm', ['exec', 'tsx', 'scripts/seed-docs.ts'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, SEED_DOCS_DIR: destDir },
      });
      if (seedAgain.status === 0) {
        ok('Seeded PDFs into the database');
      } else {
        warn('Seeding failed. Run `pnpm cli seed --dir=<path>` later.');
      }
    }
  }

  await verifyRag();

  printNextSteps(config);
}
