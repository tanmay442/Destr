import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('pg', () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [] });
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

function makePoolFactory() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const end = vi.fn().mockResolvedValue(undefined);
  return { query, end, factory: () => ({ query, end }) };
}

const silent = { log: () => {}, error: () => {} } as unknown as Console;

describe('applyMigrations', () => {
  it('runs every addColumns statement and every migration statement', async () => {
    const { query, end, factory } = makePoolFactory();
    await applyMigrations({ dir: tmp, poolFactory: factory, logger: silent });

    // 1 extension + 4 addColumns + 2 migration statements
    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls[0]?.[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(query.mock.calls[1]?.[0]).toMatch(
      /ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "blob"/,
    );
    expect(query.mock.calls[4]?.[0]).toMatch(
      /ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "notes"/,
    );
    expect(query.mock.calls[5]?.[0]).toBe('CREATE TABLE foo (id int);');
    expect(query.mock.calls[6]?.[0]).toBe('CREATE TABLE bar (id int);');
    expect(end).toHaveBeenCalledOnce();
  });

  it('skips statements that hit a known duplicate-object code', async () => {
    const { query, factory } = makePoolFactory();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate object'), { code: '42710' }),
      )
      .mockResolvedValue({ rows: [] });
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).resolves.toBeUndefined();
  });

  it('rethrows on an unknown error so the operator sees it', async () => {
    const { query, factory } = makePoolFactory();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/connection refused/);
  });

  it('skips statements whose message contains "already exists"', async () => {
    const { query, factory } = makePoolFactory();
    query.mockRejectedValueOnce(new Error('relation "x" already exists'));
    query.mockResolvedValue({ rows: [] });
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).resolves.toBeUndefined();
  });

  it('ends the pool even when a statement throws', async () => {
    const { query, end, factory } = makePoolFactory();
    query.mockRejectedValue(new Error('boom'));
    await expect(
      applyMigrations({ dir: tmp, poolFactory: factory, logger: silent }),
    ).rejects.toThrow(/boom/);
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
    ['already exists msg', new Error('foo already exists'), true],
    ['does not exist msg', new Error('role does not exist'), true],
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
