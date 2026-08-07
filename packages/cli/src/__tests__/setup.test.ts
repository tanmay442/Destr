import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEnvFile, applyToProcess, readEnvFile, refreshEnvSnapshot } from '../commands/setup';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'setup-test-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('writeEnvFile & applyToProcess', () => {
  it('removes keys set to empty string from .env.local', () => {
    const envPath = join(work, '.env.local');
    const initialLines = [
      'SECRET_KEY=old_secret',
      'KEEP_KEY=value',
      'OTHER_KEY=something',
    ];
    writeFileSync(envPath, initialLines.join('\n') + '\n');

    writeEnvFile(
      envPath,
      {
        SECRET_KEY: '',
        KEEP_KEY: 'new_value',
      },
      initialLines,
    );

    const body = readFileSync(envPath, 'utf8');
    expect(body).not.toContain('SECRET_KEY');
    expect(body).toContain('KEEP_KEY=new_value');
    expect(body).toContain('OTHER_KEY=something');
  });

  it('updates process.env and deletes empty keys', () => {
    process.env.TEMP_KEY_1 = 'val1';
    process.env.TEMP_KEY_2 = 'val2';

    applyToProcess({
      TEMP_KEY_1: 'new_val1',
      TEMP_KEY_2: '',
    });

    expect(process.env.TEMP_KEY_1).toBe('new_val1');
    expect(process.env.TEMP_KEY_2).toBeUndefined();

    delete process.env.TEMP_KEY_1;
  });

  it('refreshes the process.env snapshot from the file', () => {
    const envPath = join(work, '.env.local');
    writeFileSync(envPath, 'SNAPSHOT_KEY=snapshot_value\n');
    refreshEnvSnapshot(envPath);
    expect(process.env.SNAPSHOT_KEY).toBe('snapshot_value');
    delete process.env.SNAPSHOT_KEY;
  });

  it('does not resurrect a cleared key after the snapshot is refreshed', () => {
    const envPath = join(work, '.env.local');
    const initialLines = ['ROTATED=old_secret', 'KEEP=value'];
    writeFileSync(envPath, initialLines.join('\n') + '\n');
    process.env.ROTATED = 'old_secret';

    const vars = { ROTATED: '', KEEP: 'value' };
    writeEnvFile(envPath, vars, initialLines);
    refreshEnvSnapshot(envPath);
    applyToProcess(vars);

    expect(process.env.ROTATED).toBeUndefined();
    expect(process.env.KEEP).toBe('value');

    delete process.env.ROTATED;
    delete process.env.KEEP;
  });

  it('reads env vars correctly from env file', () => {
    const envPath = join(work, '.env.local');
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');

    const res = readEnvFile(envPath);
    expect(res.vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});
