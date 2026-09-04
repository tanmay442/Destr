import { isAbsolute, resolve } from 'node:path';
import { type Interface } from 'node:readline';
import {
  ask,
  pickFromList,
  askYesNo,
  askMultiLine,
  type PromptOption,
} from '../../prompts/index';
import type { AppConfig } from '@app/domain';
import { banner, warn } from '../common';

const TONE_OPTIONS: ReadonlyArray<PromptOption<AppConfig['agentPersona']['tone']>> = [
  { value: 'friendly', label: 'Friendly', blurb: 'warm, conversational, a few sentences' },
  { value: 'formal', label: 'Formal', blurb: 'measured, professional, no contractions' },
  { value: 'casual', label: 'Casual', blurb: 'relaxed, plain language, short replies' },
  { value: 'concise', label: 'Concise', blurb: 'direct, minimal, one or two sentences' },
];

async function promptOrg(rl: Interface, config: AppConfig): Promise<void> {
  banner('Organisation');
  config.orgName = await ask(rl, 'Company / org name', config.orgName);
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

async function promptSeed(rl: Interface, repoRoot: string): Promise<string> {
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
  return promptSeed(rl, repoRoot);
}
