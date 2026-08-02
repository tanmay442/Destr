import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ticketRepo } from '../repositories';

const dialect = new PgDialect();

function makeExecuteClient(rows: unknown[]) {
  const executed: SQL[] = [];
  const client = {
    execute(query: SQL) {
      executed.push(query);
      return Promise.resolve({ rows });
    },
  };
  return { client: client as never, executed };
}

function compiled(executed: SQL[]): string {
  return dialect.sqlToQuery(executed[executed.length - 1]!).sql.toLowerCase();
}

describe('ticketRepo.getTicketResponseTimes', () => {
  it('derives medians from audit status_change and excludes never-responded tickets', async () => {
    const { client, executed } = makeExecuteClient([
      { first_response_ms: 3_600_000, resolution_ms: 86_400_000 },
      { first_response_ms: 7_200_000, resolution_ms: null },
      { first_response_ms: null, resolution_ms: null },
    ]);
    const result = await ticketRepo.getTicketResponseTimes(undefined, client);
    expect(result.respondedCount).toBe(2);
    expect(result.resolvedCount).toBe(1);
    expect(result.medianFirstResponseMs).toBe(5_400_000);
    expect(result.medianResolutionMs).toBe(86_400_000);
    const sql = compiled(executed);
    expect(sql).toContain("kind = 'ticket'");
    expect(sql).toContain("action = 'status_change'");
    expect(sql).toContain('extract(epoch');
    expect(sql).toContain('min(c.changed_at) as first_change');
    expect(sql).toContain('max(c.changed_at) as last_change');
    expect(sql).toContain('f.last_change - f.created_at');
    expect(sql).toContain('order by t.created_at desc');
    expect(sql).toContain('limit 5000');
  });

  it('yields distinct first response and resolution for a ticket with two status changes', async () => {
    const { client } = makeExecuteClient([
      { first_response_ms: 3_600_000, resolution_ms: 172_800_000 },
    ]);
    const result = await ticketRepo.getTicketResponseTimes(undefined, client);
    expect(result.medianFirstResponseMs).toBe(3_600_000);
    expect(result.medianResolutionMs).toBe(172_800_000);
    expect(result.medianFirstResponseMs).not.toBe(result.medianResolutionMs);
    expect(result.respondedCount).toBe(1);
    expect(result.resolvedCount).toBe(1);
  });

  it('returns zero medians when there is no audit history', async () => {
    const { client } = makeExecuteClient([]);
    const result = await ticketRepo.getTicketResponseTimes(undefined, client);
    expect(result).toEqual({
      medianFirstResponseMs: 0,
      medianResolutionMs: 0,
      respondedCount: 0,
      resolvedCount: 0,
    });
  });
});
