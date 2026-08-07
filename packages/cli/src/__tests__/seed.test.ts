import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSeedArgs, runSeed } from '../commands/seed';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'seed-test-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  delete (process.env as Record<string, string | undefined>).NODE_ENV;
  delete (process.env as Record<string, string | undefined>).DATABASE_URL;
  delete (process.env as Record<string, string | undefined>).SEED_ALLOWED_ENV;
});

describe('parseSeedArgs', () => {
  it('parses --dir, --yes, and positional args', () => {
    const res = parseSeedArgs(['--dir=./custom', '--yes', 'admin-user']);
    expect(res).toEqual({
      dir: './custom',
      userId: 'admin-user',
      yes: true,
    });
  });
});

describe('runSeed', () => {
  it('blocks non-local/prod seed unless yes or SEED_ALLOWED_ENV is set', async () => {
    writeFileSync(join(work, 'test.pdf'), '%PDF-1.4\ncontent');
    process.env.DATABASE_URL = 'postgres://user:pass@remote-host.com:5432/db';
    await expect(runSeed({ fixturesDir: work })).rejects.toThrow(/blocked/);
  });

  it('rejects files exceeding PDF_PARSE_MAX_BYTES and reports failed count', async () => {
    writeFileSync(join(work, 'large.pdf'), Buffer.alloc(101_000_000));

    const res = await runSeed({
      fixturesDir: work,
      skipEnvCheck: true,
      ingest: async () => ({ documentId: 1, chunks: 5, status: 'inserted' }),
      storeBlob: async () => {},
    });

    expect(res.total).toBe(1);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(1);
  });

  it('cleans up document row if blob storage fails', async () => {
    writeFileSync(join(work, 'doc.pdf'), '%PDF-1.4\ncontent');

    const deleteMock = vi.fn().mockResolvedValue(undefined);

    const res = await runSeed({
      fixturesDir: work,
      skipEnvCheck: true,
      ingest: async () => ({ documentId: 99, chunks: 2, status: 'inserted' }),
      storeBlob: async () => {
        throw new Error('Storage write failed');
      },
      deleteDocument: deleteMock,
    });

    expect(res.failed).toBe(1);
    expect(deleteMock).toHaveBeenCalledWith(99);
  });

  it('succeeds for valid PDFs', async () => {
    writeFileSync(join(work, 'doc1.pdf'), '%PDF-1.4\ncontent');

    const res = await runSeed({
      fixturesDir: work,
      skipEnvCheck: true,
      ingest: async () => ({ documentId: 10, chunks: 3, status: 'inserted' }),
      storeBlob: async () => {},
    });

    expect(res.total).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(0);
  });
});
