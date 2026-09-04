import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Interface } from 'node:readline';
import pg from 'pg';
const { Pool } = pg;
import {
  ask,
} from '../../prompts/index';
import {
  banner,
  ok,
  warn,
  fail,
} from '../common';
import {
  type AppConfig,
} from '@app/domain';
import {
  readEnvFile,
  writeEnvFile,
  applyToProcess,
  refreshEnvSnapshot,
} from './env-file';
import {
  dbSslOptions,
  validateDbUrl,
  testEmbedding,
  validateChatVars,
  validateClerkVars,
} from './validate';

async function askSecret(rl: Interface, question: string, existing: string): Promise<string> {
  const suffix = existing ? ' [press Enter to keep existing]' : '';
  process.stdout.write(`${question}${suffix}: `);
  const stdin = process.stdin;
  rl.pause();
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (buf: Buffer) => {
      const restore = () => {
        stdin.setRawMode?.(false);
        stdin.removeListener('data', onData);
        rl.resume();
      };
      try {
        const chunk = buf.toString('utf8');
        for (const ch of chunk) {
          if (ch === '\n' || ch === '\r' || ch === '\u0004') {
            restore();
            process.stdout.write('\n');
            resolve(value === '' ? existing : value);
            return;
          }
          if (ch === '\u0003') {
            restore();
            process.stdout.write('\n');
            process.exit(1);
          }
          if (ch === '\u007f' || ch === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += ch;
        }
      } catch (err) {
        restore();
        throw err;
      }
    };
    stdin.on('data', onData);
  });
}

export function promptPrereqs(repoRoot: string): boolean {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    fail(`Node >= 18 required (found ${process.versions.node})`);
    return false;
  }
  ok(`Node ${process.versions.node}`);

  const pnpm = spawnSync('pnpm', ['--version'], { stdio: 'pipe' });
  if (pnpm.status !== 0) {
    fail('pnpm is not installed or not in PATH');
    return false;
  }
  ok(`pnpm ${pnpm.stdout.toString().trim()}`);

  if (!existsSync(join(repoRoot, 'node_modules'))) {
    warn('node_modules missing');
    console.log('  Run `pnpm install` before continuing.');
    return false;
  }
  ok('dependencies installed');

  return true;
}

export async function promptEnv(rl: Interface, envPath: string): Promise<void> {
  while (true) {
    const current = readEnvFile(envPath);
    const vars: Record<string, string> = { ...current.vars };

    banner('Database');
    {
      const prev = vars.DATABASE_URL ?? '';
      const url = await ask(rl, 'DATABASE_URL (PostgreSQL connection string)', prev);
      vars.DATABASE_URL = url;
      applyToProcess({ DATABASE_URL: url });
      const err = await validateDbUrl(url);
      if (err) {
        fail(err);
        continue;
      }
      ok('Connected to database');
    }

    banner('LLM (chat)');
    vars.CUSTOM_LLM_API_KEY = await askSecret(
      rl,
      'CUSTOM_LLM_API_KEY',
      vars.CUSTOM_LLM_API_KEY ?? '',
    );
    vars.CUSTOM_LLM_BASE_URL = await ask(rl, 'CUSTOM_LLM_BASE_URL', vars.CUSTOM_LLM_BASE_URL ?? '');
    vars.LLM_MODEL = await ask(rl, 'LLM_MODEL (e.g. claude-sonnet-4.5)', vars.LLM_MODEL ?? '');

    banner('Authentication (Clerk)');
    vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = await ask(
      rl,
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
      vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
    );
    vars.CLERK_SECRET_KEY = await askSecret(
      rl,
      'CLERK_SECRET_KEY',
      vars.CLERK_SECRET_KEY ?? '',
    );

    banner('Embedding (Google AI Studio)');
    vars.AI_STUDIO_KEY = await askSecret(rl, 'AI_STUDIO_KEY', vars.AI_STUDIO_KEY ?? '');

    writeEnvFile(envPath, vars, current.lines);
    refreshEnvSnapshot(envPath);
    applyToProcess(vars);

    const errors: string[] = [];

    const dbErr = await validateDbUrl(process.env.DATABASE_URL ?? '');
    if (dbErr) errors.push(`DATABASE_URL: ${dbErr}`);

    const embedErr = await testEmbedding();
    if (embedErr) errors.push(`Embedding: ${embedErr}`);

    const chatErr = validateChatVars();
    if (chatErr) errors.push(chatErr);

    const clerkErr = validateClerkVars();
    if (clerkErr) errors.push(clerkErr);

    if (errors.length === 0) {
      ok('All environment variables validated');
      break;
    }

    console.error('\n\x1b[31mSome checks failed. Re-enter the values:\x1b[0m');
    for (const err of errors) {
      console.error(`  \x1b[31m✗\x1b[0m ${err}`);
    }
  }
}

export function runMigration(repoRoot: string): boolean {
  banner('Database migration');

  console.log('  Running apply-migration.mjs...');
  const pre = spawnSync('node', ['scripts/apply-migration.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? '' },
  });
  if (pre.status !== 0) {
    fail('apply-migration failed');
    return false;
  }
  ok('apply-migration.mjs completed');

  console.log('  Running drizzle-kit push...');
  const push = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (push.status !== 0) {
    fail('drizzle-kit push failed');
    return false;
  }
  ok('drizzle-kit push completed');
  return true;
}

export async function verifyRag(): Promise<void> {
  banner('End-to-end verification');
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: dbSslOptions(process.env.DATABASE_URL ?? ''),
    });
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM chunks');
    const count = Number(rows[0]?.cnt ?? 0);
    if (count === 0) {
      warn('No chunks found in the database. Seed some documents first.');
    } else {
      ok(`Found ${count} chunk(s) in the database`);
    }
    await pool.end();
  } catch (err: unknown) {
    warn(`Could not verify RAG pipeline: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function printNextSteps(config: AppConfig): void {
  banner('Setup complete — next steps');
  console.log();
  console.log('  \x1b[1m1.\x1b[0m  Start the dev server:');
  console.log(`     \x1b[36mpnpm dev\x1b[0m`);
  console.log();
  console.log('  \x1b[1m2.\x1b[0m  Sign in with one of the admin emails:');
  const firstAdmin = config.adminEmails[0] ?? '<your-admin-email>';
  console.log(`     The first time \x1b[33m${firstAdmin}\x1b[0m signs in via Clerk,`);
  console.log('     they are auto-promoted to admin.');
  console.log();
  console.log('  \x1b[1m3.\x1b[0m  Upload documents:');
  console.log('     Use the admin console at /admin/upload');
  console.log();
  console.log('  \x1b[1m4.\x1b[0m  Re-run this wizard anytime:');
  console.log('     \x1b[36mpnpm configure\x1b[0m');
  console.log();
}
