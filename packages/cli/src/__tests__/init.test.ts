import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mock dotenv/config to avoid reading host .env files
vi.mock('dotenv/config', () => ({}));

import { copyPdfsFromDir, upsertAdminEmails } from '../commands/init';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'rag-setup-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});


describe('copyPdfsFromDir', () => {
  it('copies only .pdf files into the destination', () => {
    const src = join(work, 'src');
    const dst = join(work, 'dst');
    mkdirSync(src);
    writeFileSync(join(src, 'a.pdf'), '%PDF-1.4\nA');
    writeFileSync(join(src, 'b.pdf'), '%PDF-1.4\nB');
    writeFileSync(join(src, 'c.txt'), 'plain text');
    writeFileSync(join(src, 'd.docx'), 'fake docx');

    const outcome = copyPdfsFromDir(src, dst);

    expect(outcome.copied.sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(outcome.skipped.map((s) => s.file).sort()).toEqual(['c.txt', 'd.docx']);
    expect(outcome.skipped.every((s) => /only \.pdf is accepted/.test(s.reason))).toBe(true);
    expect(existsSync(join(dst, 'a.pdf'))).toBe(true);
    expect(existsSync(join(dst, 'b.pdf'))).toBe(true);
    expect(existsSync(join(dst, 'c.txt'))).toBe(false);
    expect(existsSync(join(dst, 'd.docx'))).toBe(false);
  });

  it('treats .PDF (uppercase) as accepted', () => {
    const src = join(work, 'src');
    const dst = join(work, 'dst');
    mkdirSync(src);
    writeFileSync(join(src, 'A.PDF'), '%PDF-1.4\nA');
    const outcome = copyPdfsFromDir(src, dst);
    expect(outcome.copied).toEqual(['A.PDF']);
    expect(outcome.skipped).toEqual([]);
  });

  it('reports a missing source folder', () => {
    const outcome = copyPdfsFromDir(join(work, 'missing'), join(work, 'dst'));
    expect(outcome.copied).toEqual([]);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]!.reason).toMatch(/does not exist/);
  });

  it('handles an empty source folder', () => {
    const src = join(work, 'empty');
    const dst = join(work, 'dst');
    mkdirSync(src);
    const outcome = copyPdfsFromDir(src, dst);
    expect(outcome.copied).toEqual([]);
    expect(outcome.skipped).toEqual([]);
  });
});

describe('upsertAdminEmails', () => {
  it('appends ADMIN_EMAILS to a fresh .env.local', () => {
    const envPath = join(work, '.env.local');
    upsertAdminEmails(envPath, ['a@example.com', 'b@example.com']);
    const body = readFileSync(envPath, 'utf8');
    expect(body).toContain('ADMIN_EMAILS=a@example.com,b@example.com');
  });

  it('replaces an existing ADMIN_EMAILS line', () => {
    const envPath = join(work, '.env.local');
    writeFileSync(
      envPath,
      [
        'DATABASE_URL=postgres://old',
        'ADMIN_EMAILS=old@example.com',
        'OTHER=keep',
      ].join('\n') + '\n',
    );
    upsertAdminEmails(envPath, ['new@example.com']);
    const body = readFileSync(envPath, 'utf8');
    expect(body).toContain('ADMIN_EMAILS=new@example.com');
    expect(body).not.toContain('old@example.com');
    expect(body).toContain('DATABASE_URL=postgres://old');
    expect(body).toContain('OTHER=keep');
  });

  it('does nothing when the emails list is empty', () => {
    const envPath = join(work, '.env.local');
    upsertAdminEmails(envPath, []);
    expect(existsSync(envPath)).toBe(false);
  });
});
