import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../is-main-module';

let work: string;
let prevArgv1: string | undefined;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'is-main-module-'));
  prevArgv1 = process.argv[1] as string | undefined;
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  process.argv[1] = prevArgv1 ?? '';
});

describe('isMainModule', () => {
  it('matches the entry module via realpath comparison', () => {
    const entry = join(work, 'main.ts');
    writeFileSync(entry, '');
    process.argv[1] = entry;
    expect(isMainModule(pathToFileURL(entry).href)).toBe(true);
  });

  it('returns false when argv[1] points to a different file', () => {
    const a = join(work, 'a.ts');
    const b = join(work, 'b.ts');
    writeFileSync(a, '');
    writeFileSync(b, '');
    process.argv[1] = a;
    expect(isMainModule(pathToFileURL(b).href)).toBe(false);
  });

  it('resolves symlinked entry paths before comparing', () => {
    const real = join(work, 'real.ts');
    const link = join(work, 'link.ts');
    writeFileSync(real, '');
    try {
      symlinkSync(real, link);
    } catch {
      process.argv[1] = real;
      expect(isMainModule(pathToFileURL(real).href)).toBe(true);
      return;
    }
    process.argv[1] = link;
    expect(isMainModule(pathToFileURL(real).href)).toBe(true);
  });

  it('returns false when there is no argv[1]', () => {
    process.argv[1] = '';
    expect(isMainModule('file:///anywhere.ts')).toBe(false);
  });

  it('returns false when the meta URL cannot be resolved', () => {
    process.argv[1] = join(work, 'does-not-exist.ts');
    expect(isMainModule('file:///definitely/missing.ts')).toBe(false);
  });
});