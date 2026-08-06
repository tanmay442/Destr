import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appConfigSchema } from '@app/domain/app-config';
import appConfig from '../../config/app.config';

const REPO_ROOT = process.cwd();

function trackedSourceFiles(): string[] {
  const out = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !f.endsWith('config-drift.test.ts'));
}

describe('config constants drift-guard (M35)', () => {
  it('no source file imports the deleted root config/constants re-export', () => {
    const offenders: string[] = [];
    for (const file of trackedSourceFiles()) {
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (line.includes('config/constants')) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('domain schema outOfScopeTopics default stays aligned with config/app.config.ts', () => {
    const schemaDefaults = appConfigSchema.parse({}).outOfScopeTopics;
    expect(schemaDefaults).toEqual(appConfig.outOfScopeTopics);
  });
});
