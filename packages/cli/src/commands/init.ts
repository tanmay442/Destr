// `rag-agent init` (alias `pnpm configure`): interactive first-time setup that
// writes config/app.config.ts, .env.local, copies seed PDFs, and runs seed.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { type Interface } from 'node:readline';
import 'dotenv/config';
import {
  makeRl,
  ask,
  pickFromList,
  askYesNo,
  askMultiLine,
  type PromptOption,
} from '../prompts/index';

export interface PdfCopyOutcome {
  copied: string[];
  skipped: Array<{ file: string; reason: string }>;
}

export function copyPdfsFromDir(sourceDir: string, destDir: string): PdfCopyOutcome {
  const outcome: PdfCopyOutcome = { copied: [], skipped: [] };
  if (!existsSync(sourceDir)) {
    outcome.skipped.push({ file: sourceDir, reason: 'folder does not exist' });
    return outcome;
  }
  const stat = statSync(sourceDir);
  if (!stat.isDirectory()) {
    outcome.skipped.push({ file: sourceDir, reason: 'not a directory' });
    return outcome;
  }
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(sourceDir);
  for (const name of entries) {
    const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
    if (ext !== '.pdf') {
      outcome.skipped.push({
        file: name,
        reason: 'only .pdf is accepted — non-PDFs are ignored by the RAG pipeline',
      });
      continue;
    }
    const src = join(sourceDir, name);
    if (!statSync(src).isFile()) {
      outcome.skipped.push({ file: name, reason: 'not a regular file' });
      continue;
    }
    copyFileSync(src, join(destDir, name));
    outcome.copied.push(name);
  }
  return outcome;
}

export function upsertAdminEmails(envPath: string, emails: string[]): void {
  if (emails.length === 0) return;
  const csv = emails.join(',');
  let body = '';
  if (existsSync(envPath)) {
    body = readFileSync(envPath, 'utf8');
  }
  const lines = body.split(/\r?\n/);
  let found = false;
  const next: string[] = [];
  for (const line of lines) {
    if (/^ADMIN_EMAILS\s*=/.test(line)) {
      next.push(`ADMIN_EMAILS=${csv}`);
      found = true;
    } else {
      next.push(line);
    }
  }
  if (!found) {
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push(`ADMIN_EMAILS=${csv}`);
  }
  writeFileSync(envPath, next.join('\n'));
}

// Reuse the config schema from @app/domain so the CLI stays in sync.
import { appConfigSchema, type AppConfig } from '@app/domain';

const TONE_OPTIONS: ReadonlyArray<PromptOption<AppConfig['agentPersona']['tone']>> = [
  { value: 'friendly', label: 'Friendly', blurb: 'warm, conversational, a few sentences' },
  { value: 'formal', label: 'Formal', blurb: 'measured, professional, no contractions' },
  { value: 'casual', label: 'Casual', blurb: 'relaxed, plain language, short replies' },
  { value: 'concise', label: 'Concise', blurb: 'direct, minimal, one or two sentences' },
];

import { banner, ok, warn, loadCurrentDefaults } from './common';

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
  seedReason?: string;
}

async function promptOrg(rl: Interface, config: AppConfig): Promise<void> {
  banner('Organisation');
  config.orgName = await ask(rl, 'Company / org name', config.orgName);
  config.orgShortName = await ask(rl, 'Short name (nav brand)', config.orgShortName);
  config.audience = await ask(
    rl,
    'Who does the agent talk to? (e.g. "your customers")',
    config.audience,
  );
}

async function promptPersona(rl: Interface, config: AppConfig): Promise<void> {
  banner('Agent persona');
  const personaNameInput = await ask(
    rl,
    'Agent name (optional, blank for none)',
    config.agentPersona.name ?? '',
  );
  config.agentPersona = {
    name: personaNameInput === '' ? undefined : personaNameInput,
    tone: await pickFromList(rl, 'Tone:', TONE_OPTIONS, config.agentPersona.tone),
  };
}

async function promptOutOfScope(rl: Interface, config: AppConfig): Promise<void> {
  banner('Out-of-scope topics');
  console.log('Current list:');
  for (const t of config.outOfScopeTopics) {
    console.log(`  - ${t.topic}: ${t.handling}`);
  }
  if (await askYesNo(rl, 'Edit the out-of-scope list?', false)) {
    const next: AppConfig['outOfScopeTopics'] = [];
    let first = true;
    for (const existing of config.outOfScopeTopics) {
      const keep = await askYesNo(rl, `Keep "${existing.topic}"?`, first);
      first = false;
      if (keep) next.push(existing);
    }
    let addMore = await askYesNo(rl, 'Add a new out-of-scope topic?', false);
    while (addMore) {
      const topic = await ask(rl, '  topic (e.g. "fee negotiation")', '');
      if (!topic) break;
      const handling = await ask(rl, `  handling for "${topic}"`, '');
      if (!handling) break;
      next.push({ topic, handling });
      addMore = await askYesNo(rl, 'Add another?', false);
    }
    config.outOfScopeTopics = next;
  }
}

async function promptCustomInstructions(rl: Interface, config: AppConfig): Promise<void> {
  banner('Custom instructions');
  console.log('Anything extra the agent should always do or never do?');
  const custom = await askMultiLine(
    rl,
    'Custom instructions (optional):',
    config.customInstructions ?? '',
  );
  config.customInstructions = custom === '' ? undefined : custom;
}

async function promptAdmin(rl: Interface, config: AppConfig): Promise<void> {
  banner('Admin emails');
  console.log('Comma-separated. The first time one of these emails signs in via Clerk,');
  console.log('they are auto-promoted to admin.');
  const adminInput = await ask(
    rl,
    'Admin emails (comma-separated, blank to skip)',
    config.adminEmails.join(', '),
  );
  const parsedEmails = adminInput
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  config.adminEmails = parsedEmails;
}

async function promptBranding(rl: Interface, config: AppConfig): Promise<void> {
  banner('Branding');
  config.branding = {
    title: await ask(rl, 'Browser tab title', config.branding.title),
    description: await ask(rl, 'Meta description', config.branding.description),
  };
}

async function promptSeed(rl: Interface, config: AppConfig, repoRoot: string): Promise<string> {
  banner('Seed PDFs');
  const sourceDir = await ask(
    rl,
    'Path to a folder of PDFs (leave empty to skip — upload via /admin/upload later)',
    '',
  );
  if (!sourceDir) {
    warn('Skipped. You can upload documents later via /admin/upload.');
    return '';
  }
  const absSource = isAbsolute(sourceDir) ? sourceDir : resolve(repoRoot, sourceDir);
  console.log(`  resolved: ${absSource}`);
  return absSource;
}

export async function runConfigPrompts(
  rl: Interface,
  config: AppConfig,
  repoRoot: string,
): Promise<string> {
  await promptOrg(rl, config);
  await promptPersona(rl, config);
  await promptOutOfScope(rl, config);
  await promptCustomInstructions(rl, config);
  await promptAdmin(rl, config);
  await promptBranding(rl, config);
  return promptSeed(rl, config, repoRoot);
}

export function validateConfig(
  rl: Interface,
  config: AppConfig,
): AppConfig {
  const validated = appConfigSchema.safeParse(config);
  if (!validated.success) {
    console.error('\nInvalid configuration:');
    for (const i of validated.error.issues) {
      console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    }
    rl.close();
    throw new Error('Invalid configuration');
  }
  return validated.data;
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
  const defaults = await loadCurrentDefaults(REPO_ROOT, CONFIG_PATH);
  let config: AppConfig = defaults;

  console.log('\n\x1b[1mRAG Support Agent — setup\x1b[0m');
  console.log('Press Enter to keep the current value shown in [brackets].\n');

  const absSource = await runConfigPrompts(rl, config, REPO_ROOT);
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

function writeConfigFile(configPath: string, config: AppConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, renderConfigFile(config));
}

function jsonToTs(obj: unknown, indent = 2): string {
  const recurse = (val: unknown, depth: number): string => {
    const pad = ' '.repeat(indent * depth);
    const padInner = ' '.repeat(indent * (depth + 1));

    if (val === null || val === undefined) return 'undefined';
    if (typeof val === 'string') {
      const escaped = val
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
      return `"${escaped}"`;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      const items = val.map((item) => `${padInner}${recurse(item, depth + 1)}`);
      return `[\n${items.join(',\n')}\n${pad}]`;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) return '{}';
      const entries = keys.map((k) => {
        const v = recurse((val as Record<string, unknown>)[k], depth + 1);
        return `${padInner}${k}: ${v}`;
      });
      return `{\n${entries.join(',\n')}\n${pad}}`;
    }
    return String(val);
  };
  return recurse(obj, 0);
}

function renderConfigFile(config: AppConfig): string {
  const body = jsonToTs(config);
  return `import type { AppConfig } from '@app/domain';

// Runtime configuration for this deployment of the RAG Support Agent.
// Edit any field, or run \`pnpm configure\` to be walked through the values
// interactively. The schema validates this object on load.

const config: AppConfig = ${body};

export default config;
`;
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

import { cliMain } from './common';

cliMain(() => {
  const repoRoot = process.cwd();
  return runInit({ repoRoot });
});
