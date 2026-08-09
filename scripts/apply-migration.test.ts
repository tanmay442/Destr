import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pg', () => {
  class FakePool {
    connect = vi.fn().mockResolvedValue({});
    end = vi.fn().mockResolvedValue(undefined);
  }
  return {
    default: { Pool: FakePool },
  };
});

import { applyMigrations, __test } from './apply-migration.mjs';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'apply-mig-'));
  writeFileSync(
    join(tmp, '0000_init.sql'),
    'CREATE TABLE foo (id int);\n--> statement-breakpoint\nCREATE TABLE bar (id int);\n',
  );
});

type FakedPool = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  factory: () => {
    connect: () => Promise<{ query: (...args: unknown[]) => unknown; release: () => unknown }>;
    end: () => Promise<unknown>;
  };
};

function makePoolFactory(): FakedPool {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  return {
    query,
    release,
    end,
    factory: () => ({
      connect: () => Promise.resolve({ query, release }),
      end,
    }),
  };
}

const silent = { log: () => {}, error: () => {} } as unknown as Console;

describe('applyMigrations', () => {
  it('runs every addColumns statement and every migration statement', async () => {
    const { query, release, end, factory } = makePoolFactory();
    await applyMigrations({ dir: tmp, poolFactory: factory, logger: silent });

    expect(query).toHaveBeenCalledTimes(10);
    expect(query.mock.calls[0]?.[0]).toBe('SELECT pg_advisory_lock($1)');
    expect(query.mock.calls[1]?.[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(query.mock.calls[2]?.[0]).toMatch(/CREATE TABLE IF NOT EXISTS .*_migrations/);
    expect(query.mock.calls[4]?.[0]).toBe('BEGIN');
    expect(query.mock.calls[5]?.[0]).toBe('CREATE TABLE foo (id int);');
    expect(query.mock.calls[6]?.[0]).toBe('CREATE TABLE bar (id int);');
    expect(query.mock.calls[7]?.[0]).toMatch(/INSERT INTO .*_migrations/);
    expect(query.mock.calls[8]?.[0]).toBe('COMMIT');
    expect(query.mock.calls[9]?.[0]).toBe('SELECT pg_advisory_unlock($1)');
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it('advisory lock is taken and released', async () => {
    const { query, factory } = makePoolFactory();
    await applyMigrations({ dir: tmp, poolFactory: factory, logger: silent });
    expect(query.mock.calls[0]?.[0]).toBe('SELECT pg_advisory_lock($1)');
    const last = query.mock.calls[query.mock.calls.length - 1]?.[0];
    expect(last).toBe('SELECT pg_advisory_unlock($1)');
  });

  it('wraps each migration file in a transaction', async () => {
    const { query, factory } = makePoolFactory();
    await applyMigrations({ dir: tmp, poolFactory: factory, logger: silent });
    const hasBegin = query.mock.calls.some(([sql]) => sql === 'BEGIN');
    const hasCommit = query.mock.calls.some(([sql]) => sql === 'COMMIT');
    expect(hasBegin).toBe(true);
    expect(hasCommit).toBe(true);
  });

  it('rolls back the file transaction when a statement fails mid-file', async () => {
    const { query, factory } = makePoolFactory();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23505' }));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/boom/);
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    const inserted = query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO'),
    );
    expect(inserted).toBe(false);
  });

  it('refuses a benign skip for a migration file never recorded', async () => {
    const { query, factory } = makePoolFactory();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(Object.assign(new Error('dup obj'), { code: '42710' }));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/Refusing benign skip/);
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });

  it('rejects re-running an already-applied file whose content changed', async () => {
    const { query, factory } = makePoolFactory();
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ file_name: '0000_init.sql', hash: 'different' }],
      });
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/already applied but its content changed/);
  });

  it('skips migrations already applied with the same hash', async () => {
    const { query, factory } = makePoolFactory();
    const content = readFileSync(join(tmp, '0000_init.sql'), 'utf8');
    const hash = __test.simpleHash(content);
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ file_name: '0000_init.sql', hash }],
      });
    await applyMigrations({ dir: tmp, poolFactory: factory, logger: silent });
    const began = query.mock.calls.some(([sql]) => sql === 'BEGIN');
    expect(began).toBe(false);
  });

  it('rethrows on an unknown error so the operator sees it', async () => {
    const { query, factory } = makePoolFactory();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/connection refused/);
  });

  it('releases the client and ends the pool even when a statement throws', async () => {
    const { query, release, end, factory } = makePoolFactory();
    query.mockRejectedValue(new Error('boom'));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/boom/);
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe('isBenignError', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['42710', { code: '42710', message: 'dup obj' }, true],
    ['42P07', { code: '42P07', message: 'dup table' }, true],
    ['42701', { code: '42701', message: 'dup col' }, true],
    ['42P06', { code: '42P06', message: 'dup schema' }, true],
    ['42P10', { code: '42P10', message: 'dup obj' }, true],
    ['already exists msg', new Error('foo already exists'), false],
    ['does not exist msg', new Error('role does not exist'), false],
    ['unknown error', new Error('connection refused'), false],
    ['null', null, false],
  ];
  for (const [name, err, expected] of cases) {
    it(`returns ${expected} for ${name}`, () => {
      expect(__test.isBenignError(err)).toBe(expected);
    });
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});