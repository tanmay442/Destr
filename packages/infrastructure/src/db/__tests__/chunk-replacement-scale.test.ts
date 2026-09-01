import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { deleteStaleChunks } from '../chunk-store';

type DeleteClient = Parameters<typeof deleteStaleChunks>[2];

describe('bounded stale chunk deletion', () => {
  it('uses one PostgreSQL array parameter for more than 65,535 retained UIDs', async () => {
    const execute = vi.fn(async (statement: Parameters<DeleteClient['execute']>[0]) => {
      if (!(statement instanceof SQL)) throw new Error('Expected a Drizzle SQL statement');
      const query = new PgDialect().sqlToQuery(statement);
      expect(query.sql).toContain('unnest($2::text[])');
      expect(query.params).toHaveLength(3);
      expect(query.params[1]).toHaveLength(65_536);
      return { rows: [] };
    });
    const retained = Array.from({ length: 65_536 }, (_, index) => `uid-${index}`);

    await deleteStaleChunks(42, retained, { execute } as unknown as DeleteClient);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps empty retained sets valid and array-backed', async () => {
    const execute = vi.fn(async (statement: Parameters<DeleteClient['execute']>[0]) => {
      if (!(statement instanceof SQL)) throw new Error('Expected a Drizzle SQL statement');
      const query = new PgDialect().sqlToQuery(statement);
      expect(query.sql).toContain('unnest($2::text[])');
      expect(query.params[1]).toEqual([]);
      return { rows: [] };
    });

    await deleteStaleChunks(42, [], { execute } as unknown as DeleteClient);
  });
});
