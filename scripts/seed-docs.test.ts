import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ingestFileMock } = vi.hoisted(() => ({
  ingestFileMock: vi.fn(),
}));

vi.mock('@app/application/rag/ingest', () => ({
  ingestFile: ingestFileMock,
}));

vi.mock('@app/infrastructure', () => ({
  Db: {
    db: {},
    schema: { documents: {} },
  },
  Llm: {},
  Pdf: {},
  Auth: {},
  Storage: { createBlobStorage: () => ({ put: vi.fn() }) },
}));

vi.mock('dotenv/config', () => ({}));

import { parseArgs } from './seed-docs';
import { runSeed } from '../packages/cli/src/commands/seed';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  ingestFileMock.mockReset();
});

describe('seed-docs', () => {
  it('exits with an error when no fixtures are present', async () => {
    await expect(
      runSeed({ fixturesDir: join(HERE, 'does-not-exist') }),
    ).rejects.toThrow(/Cannot read fixtures directory/);
  });
});

describe('parseArgs', () => {
  it('defaults to ./documents when no flag is given', () => {
    expect(parseArgs([])).toEqual({ dir: './documents', userId: undefined });
  });

  it('reads --dir=VALUE', () => {
    expect(parseArgs(['--dir=./x'])).toEqual({ dir: './x', userId: undefined });
  });

  it('reads --dir VALUE (space-separated form)', () => {
    expect(parseArgs(['--dir', './x'])).toEqual({ dir: './x', userId: undefined });
  });

  it('treats a trailing --dir with no value as the default', () => {
    expect(parseArgs(['--dir'])).toEqual({ dir: './documents', userId: undefined });
  });

  it('does not consume a flag-looking value after --dir', () => {
    expect(parseArgs(['--dir', '--something'])).toEqual({
      dir: './documents',
      userId: undefined,
    });
  });

  it('captures a positional userId after --dir=VALUE', () => {
    expect(parseArgs(['--dir=./x', 'admin-1'])).toEqual({
      dir: './x',
      userId: 'admin-1',
    });
  });

  it('falls back to SEED_DOCS_DIR when --dir is absent', () => {
    const prev = process.env.SEED_DOCS_DIR;
    process.env.SEED_DOCS_DIR = './from-env';
    try {
      expect(parseArgs([])).toEqual({ dir: './from-env', userId: undefined });
    } finally {
      if (prev === undefined) delete process.env.SEED_DOCS_DIR;
      else process.env.SEED_DOCS_DIR = prev;
    }
  });
});
