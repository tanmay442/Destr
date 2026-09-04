import {
  existsSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Interface } from 'node:readline';
import {
  makeRl,
} from '../../prompts/index';
import type { AppConfig } from '@app/domain';
import { ok, warn, loadCurrentDefaults } from '../common';
import { copyPdfsFromDir, upsertAdminEmails, type PdfCopyOutcome } from './files';
import { runConfigPrompts } from './prompts';
import { validateConfig, writeConfigFile } from './config-file';

export interface InitOptions {
  repoRoot: string;
}

export interface InitResult {
  ok: boolean;
  configPath: string;
  envPath: string;
  destDir: string;
  copied: string[];
  skipped: Array<{ file: string; reason: string }>;
  ranSeed: boolean;
  seedReason?: string | undefined;
}

export async function writeOutputs(opts: {
  repoRoot: string;
  configPath: string;
  envPath: string;
  config: AppConfig;
  absSource: string;
  destDir: string;
  rl: Interface;
}): Promise<InitResult> {
  const { repoRoot, configPath, envPath, config, absSource, destDir, rl } = opts;

  writeConfigFile(configPath, config);
  ok(`wrote ${relative(repoRoot, configPath)}`);
  upsertAdminEmails(envPath, config.adminEmails);
  if (config.adminEmails.length > 0) {
    ok(`wrote ADMIN_EMAILS to ${relative(repoRoot, envPath)}`);
  }

  let outcome: PdfCopyOutcome = { copied: [], skipped: [] };
  if (absSource) {
    outcome = copyPdfsFromDir(absSource, destDir);
  }
  if (outcome.copied.length > 0) {
    ok(`copied ${outcome.copied.length} PDF(s) to ${relative(repoRoot, destDir)}/`);
  } else if (!absSource) {
    console.log('  (PDFs skipped — upload via /admin/upload later)');
  } else {
    console.log(`  (no PDFs copied from ${absSource})`);
  }
  for (const s of outcome.skipped) {
    console.log(`\x1b[33m  ⚠ skipped ${s.file}: ${s.reason}\x1b[0m`);
  }
  if (outcome.skipped.length > 0) {
    console.log(`  Hint: the RAG pipeline only accepts .pdf files. ${outcome.skipped.length} non-PDF(s) ignored.`);
  }

  let ran = false;
  let reason: string | undefined;
  if (absSource && outcome.copied.length > 0) {
    ({ ran, reason } = runSeedIfPossible(repoRoot, destDir));
  } else {
    reason = 'No PDFs to seed';
  }
  if (ran) {
    ok('seeded PDFs into the database');
  } else {
    console.log(`\x1b[33m  ⚠ seed skipped: ${reason}\x1b[0m`);
  }

  rl.close();
  return {
    ok: true,
    configPath,
    envPath,
    destDir,
    copied: outcome.copied,
    skipped: outcome.skipped,
    ranSeed: ran,
    seedReason: reason,
  };
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const REPO_ROOT = opts.repoRoot;
  const CONFIG_PATH = join(REPO_ROOT, 'config', 'app.config.ts');
  const ENV_PATH = join(REPO_ROOT, '.env.local');

  const rl = makeRl();
  const defaults = await loadCurrentDefaults(CONFIG_PATH);
  let config: AppConfig = defaults;

  console.log('\n\x1b[1mDestr — setup\x1b[0m');
  console.log('Press Enter to keep the current value shown in [brackets].\n');

  const absSourceRaw = await runConfigPrompts(rl, config, REPO_ROOT);
  let absSource = absSourceRaw;
  if (absSource && (!existsSync(absSource) || readdirSync(absSource).length === 0)) {
    absSource = '';
    warn('No PDFs found in the seed directory. You can upload documents later via /admin/upload.');
  }
  config = validateConfig(rl, config);

  const destDir = isAbsolute(config.seedDocsDir)
    ? config.seedDocsDir
    : resolve(REPO_ROOT, config.seedDocsDir);

  return writeOutputs({
    repoRoot: REPO_ROOT,
    configPath: CONFIG_PATH,
    envPath: ENV_PATH,
    config,
    absSource,
    destDir,
    rl,
  });
}

function runSeedIfPossible(repoRoot: string, destDir: string): { ran: boolean; reason?: string } {
  if (!process.env.DATABASE_URL) {
    return {
      ran: false,
      reason: 'DATABASE_URL is not set in .env.local; re-run `pnpm configure` (or just `pnpm seed`) once you have a Neon database.',
    };
  }
  const result = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/seed-docs.ts'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, SEED_DOCS_DIR: destDir },
    },
  );
  if (result.status !== 0) {
    return { ran: false, reason: `seed script exited with status ${result.status ?? 'unknown'}` };
  }
  return { ran: true };
}
