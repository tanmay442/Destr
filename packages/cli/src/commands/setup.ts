import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Interface } from 'node:readline';
import pg from 'pg';
import 'dotenv/config';

import {
  makeRl,
  ask,
  askYesNo,
} from '../prompts/index';
import {
  writeOutputs,
  runConfigPrompts,
  validateConfig,
} from './init';
import {
  banner,
  ok,
  warn,
  fail,
  loadCurrentDefaults,
} from './common';
import {
  type AppConfig,
} from '@app/domain';
import { Llm } from '@app/infrastructure';

const { Pool } = pg;

function readEnvFile(envPath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(envPath)) return result;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

function writeEnvFile(envPath: string, vars: Record<string, string>): void {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

function applyToProcess(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v) process.env[k] = v;
  }
}

async function askSecret(rl: Interface, question: string, existing: string): Promise<string> {
  const answer = await ask(rl, `${question} [hidden]`, '');
  return answer === '' ? existing : answer;
}

// ── Prereq checks ──────────────────────────────────────────────

function promptPrereqs(repoRoot: string): boolean {
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

// ── DB validation ──────────────────────────────────────────────

async function validateDbUrl(url: string): Promise<string | null> {
  if (!url) return 'DATABASE_URL is required';
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await pool.end();
  }
}

// ── Embedding test ─────────────────────────────────────────────

async function testEmbedding(): Promise<string | null> {
  if (!process.env.AI_STUDIO_KEY) return 'AI_STUDIO_KEY is not set in environment';
  try {
    const result = await Llm.getEmbeddingService().embed('validation-test-vector');
    if (!result || result.length === 0) return 'Embedding returned empty vector';
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ── Chat endpoint validation ───────────────────────────────────

function validateChatVars(): string | null {
  if (!process.env.CUSTOM_LLM_API_KEY) return 'CUSTOM_LLM_API_KEY is not set';
  if (!process.env.CUSTOM_LLM_BASE_URL) return 'CUSTOM_LLM_BASE_URL is not set';
  if (!process.env.LLM_MODEL) return 'LLM_MODEL is not set';
  return null;
}

// ── Clerk validation ───────────────────────────────────────────

function validateClerkVars(): string | null {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set';
  }
  if (!process.env.CLERK_SECRET_KEY) return 'CLERK_SECRET_KEY is not set';
  return null;
}

// ── Env collection (step 2-4 combined) ─────────────────────────

async function promptEnv(rl: Interface, envPath: string): Promise<void> {
  while (true) {
    const existing = readEnvFile(envPath);
    const vars: Record<string, string> = { ...existing };

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

    writeEnvFile(envPath, vars);
    applyToProcess(vars);

    // ── Validate everything ──────────────────────────────────────
    const errors: string[] = [];

    // DB was already validated inline, but re-check in case .env.local was overwritten
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
    // Loop back to re-prompt
  }
}

// ── Migration ──────────────────────────────────────────────────

function runMigration(repoRoot: string): boolean {
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
  const push = spawnSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
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

// ── Verify RAG ─────────────────────────────────────────────────

async function verifyRag(): Promise<void> {
  banner('End-to-end verification');
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
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

// ── Next steps ─────────────────────────────────────────────────

function printNextSteps(repoRoot: string, config: AppConfig): void {
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

// ── Orchestrator ───────────────────────────────────────────────

export async function runSetup(repoRoot: string): Promise<void> {
  const CONFIG_PATH = join(repoRoot, 'config', 'app.config.ts');
  const ENV_PATH = join(repoRoot, '.env.local');

  console.log('\n\x1b[1mRAG Support Agent — setup\x1b[0m');
  console.log('This wizard configures everything needed to run the RAG Support Agent.\n');

  // Step 1: Prereq checks
  if (!promptPrereqs(repoRoot)) {
    console.error('\nFix the issues above and re-run `pnpm configure`.');
    process.exit(1);
  }

  // Step 2-4: Environment collection, embedding model, and validation
  const rl = makeRl();
  await promptEnv(rl, ENV_PATH);

  // Step 5: Migration
  banner('Migration');
  if (await askYesNo(rl, 'Run database migration now?', true)) {
    runMigration(repoRoot);
  } else {
    warn('Skipped migration. Run `pnpm cli db-migrate` later.');
  }

  // Step 6: Init prompts (org, persona, admin, docs)
  banner('Configuration');
  console.log('Press Enter to keep the current value shown in [brackets].\n');

  const defaults = await loadCurrentDefaults(repoRoot, CONFIG_PATH);
  let config: AppConfig = defaults;

  let absSource = await runConfigPrompts(rl, config, repoRoot);

  const destDir = isAbsolute(config.seedDocsDir)
    ? config.seedDocsDir
    : resolve(repoRoot, config.seedDocsDir);

  // If no PDFs found, skip seeding
  if (!absSource || !existsSync(absSource) || readdirSync(absSource).length === 0) {
    absSource = '';
    warn('No PDFs found. You can upload documents later via /admin/upload.');
  }

  // Validate config schema
  try {
    config = validateConfig(rl, config);
  } catch {
    process.exit(1);
  }

  // Step 7: Write config, admin emails, copy PDFs, run seed (closes rl)
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

  // rl is now closed by writeOutputs

  // If writeOutputs did not seed (e.g. no DATABASE_URL at that point), offer alternative
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

  // Step 8: Verify end-to-end
  await verifyRag();

  // Step 9: Next steps
  printNextSteps(repoRoot, config);
}

// ── CLI entry ───────────────────────────────────────────────────

import { cliMain } from './common';

cliMain(() => {
  const repoRoot = process.cwd();
  return runSetup(repoRoot);
});
