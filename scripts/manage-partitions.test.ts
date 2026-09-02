import { describe, expect, it } from 'vitest';
import {
  futurePartitionNames,
  normalizeMonthsAhead,
  parsePartitionArgs,
  runPartitionMaintenance,
  type PoolLike,
} from './manage-partitions';

const NOW = new Date('2026-09-15T12:00:00.000Z');

function dryRunPool(): PoolLike {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      if (text.includes('current_database()')) {
        return { rows: [{ database: 'ragagent', user: 'migration_owner', owns_parents: true, parent_count: 3 }] as unknown as T[] };
      }
      if (text.includes('FROM pg_inherits')) {
        return {
          rows: [
            ...futurePartitionNames('chat_events', NOW).map((relname) => ({ relname })),
            ...futurePartitionNames('audit_events', NOW).map((relname) => ({ relname })),
          ] as unknown as T[],
        };
      }
      if (text.includes('chat_events_default')) return { rows: [{ chat_events: 0, audit_events: 0 }] as unknown as T[] };
      if (text.includes('FROM pg_indexes')) return { rows: [] as T[] };
      throw new Error(`unexpected query: ${text}`);
    },
    async end() {},
  };
}

describe('manage-partitions', () => {
  it('keeps a seven-boundary future window and crosses year boundaries', () => {
    expect(futurePartitionNames('chat_events', NOW)).toEqual([
      'chat_events_2026_09',
      'chat_events_2026_10',
      'chat_events_2026_11',
      'chat_events_2026_12',
      'chat_events_2027_01',
      'chat_events_2027_02',
      'chat_events_2027_03',
    ]);
  });

  it('requires at least six months of coverage and caps operator input', () => {
    expect(normalizeMonthsAhead(0)).toBe(6);
    expect(normalizeMonthsAhead(6)).toBe(6);
    expect(normalizeMonthsAhead(999)).toBe(24);
  });

  it('parses safe dry-run and explicit database confirmation flags', () => {
    expect(parsePartitionArgs([])).toMatchObject({ apply: false, dryRun: true, monthsAhead: 6 });
    expect(parsePartitionArgs(['--apply', '--confirm-database=ragagent', '--months-ahead=12'])).toEqual({
      apply: true,
      dryRun: false,
      allowDefaultRows: false,
      confirmDatabase: 'ragagent',
      monthsAhead: 12,
    });
    expect(() => parsePartitionArgs(['--apply'])).not.toThrow();
    expect(() => parsePartitionArgs(['--months-ahead=5'])).toThrow(/from 6 to 24/);
  });

  it('does not mutate a dry run and reports a complete future window', async () => {
    let writes = 0;
    const pool = dryRunPool();
    const wrapped: PoolLike = {
      ...pool,
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ) {
        if (text.startsWith('BEGIN') || text.startsWith('CREATE') || text.startsWith('SET') || text.includes('advisory')) writes += 1;
        return pool.query<T>(text, values);
      },
    };
    const result = await runPartitionMaintenance(
      { ...parsePartitionArgs([]), databaseUrl: 'postgres://owner@localhost/ragagent', now: NOW },
      () => wrapped,
    );
    expect(result.applied).toBe(false);
    expect(result.status.missingFuture).toEqual([]);
    expect(writes).toBe(0);
  });
});
