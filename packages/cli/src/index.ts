import { runInit } from './commands/init';
import { runSetup } from './commands/setup';
import { runSeed, parseSeedArgs } from './commands/seed';
import { runUpload, parseUploadArgs } from './commands/upload';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { askYesNo, makeRl } from './prompts/index';
import { getRepoRoot } from './commands/common';

const REPO_ROOT = getRepoRoot();

function usage(): void {
  console.log(`Usage: rag-agent <command> [args]

Commands:
  init               Interactive setup (same as \`pnpm configure\`).
  setup              One-command interactive first-run wizard.
  seed [--dir=...]   Ingest every PDF in the given dir.
  upload --md=FILE   Upload pre-chunked Markdown (see --help in the upload module).
  db-migrate [args]  Run drizzle-kit push (or other migration command).
`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  switch (cmd) {
    case 'init':
      await runInit({ repoRoot: REPO_ROOT });
      return;
    case 'setup':
      await runSetup(REPO_ROOT);
      return;
    case 'seed': {
      const { dir, userId } = parseSeedArgs(rest);
      await runSeed({ userId, fixturesDir: resolve(REPO_ROOT, dir) });
      return;
    }
    case 'upload': {
      const args = parseUploadArgs(rest);
      await runUpload({
        md: args.md,
        pdf: args.pdf,
        name: args.name,
        user: args.user,
        delimiter: args.delimiter,
        dryRun: args.dryRun,
      });
      return;
    }
    case 'db-migrate': {
      // apply-migration first: enables pgvector + pending SQL migrations
      const pre = spawnSync('node', ['scripts/apply-migration.mjs'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' },
      });
      if (pre.status !== 0) {
        process.exit(pre.status ?? 1);
      }
      if (rest.includes('--force')) {
        const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', ...rest], {
          cwd: REPO_ROOT,
          stdio: 'inherit',
        });
        process.exit(result.status ?? 0);
      }
      console.log('About to run a destructive `drizzle-kit push` against the database in DATABASE_URL.');
      const rl = makeRl();
      const confirmed = await askYesNo(rl, 'Proceed with the schema push?', false);
      rl.close();
      if (!confirmed) {
        console.log('Aborted. Re-run with --force to skip this confirmation.');
        return;
      }
      const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', ...rest], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
      process.exit(result.status ?? 0);
    }
    default:
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('rag-agent failed:', err);
  process.exit(1);
});
