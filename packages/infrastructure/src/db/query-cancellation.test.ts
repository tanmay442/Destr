import { describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from './client';
import {
  DatabaseQueryCancelledError,
  executeCancelable,
  executeDatabaseCancelable,
} from './query-cancellation';

describe('executeCancelable', () => {
  it('does not start an operation when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));
    const operation = vi.fn(async () => 'unreachable');

    await expect(executeCancelable({ operation, signal: controller.signal }))
      .rejects.toBeInstanceOf(DatabaseQueryCancelledError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not start when abort races the lazy microtask', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => 'unreachable');
    const result = executeCancelable({ operation, signal: controller.signal });
    controller.abort(new Error('client disconnected'));

    await expect(result).rejects.toBeInstanceOf(DatabaseQueryCancelledError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('normalizes cancellation while the operation is pending', async () => {
    const controller = new AbortController();
    let settle: (() => void) | undefined;
    const operation = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const result = executeCancelable({ operation, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(DatabaseQueryCancelledError);
    settle?.();
  });

  it('invokes a supplied driver cancellation hook once', async () => {
    const controller = new AbortController();
    let settle: (() => void) | undefined;
    const operation = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const cancel = vi.fn();
    const result = executeCancelable({ operation, signal: controller.signal, cancel });
    await Promise.resolve();
    controller.abort();
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(DatabaseQueryCancelledError);
    expect(cancel).toHaveBeenCalledTimes(1);
    settle?.();
  });

  it('preserves a provider failure that wins before a later abort', async () => {
    const controller = new AbortController();
    const failure = new Error('database unavailable');
    const result = executeCancelable({ operation: async () => { throw failure; }, signal: controller.signal });

    await expect(result).rejects.toBe(failure);
    controller.abort();
  });
});

describe('executeDatabaseCancelable queryClass timeouts', () => {
  const dialect = new PgDialect();
  function makeTransactionCapableClient() {
    const executed: SQL[] = [];
    const tx = {
      execute: (query: SQL) => {
        executed.push(query);
        return Promise.resolve({ rows: [] });
      },
    };
    const client = {
      execute: (query: SQL) => {
        executed.push(query);
        return Promise.resolve({ rows: [] });
      },
      transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };
    return { client: client as never, executed, tx };
  }
  function statementsOf(executed: SQL[]): string[] {
    return executed.map((query) => dialect.sqlToQuery(query).sql);
  }

  it('issues SET LOCAL statement_timeout inside a transaction for retrieval_vector', async () => {
    const { client, executed } = makeTransactionCapableClient();
    const seen: unknown[] = [];
    const result = await executeDatabaseCancelable({
      client,
      queryClass: 'retrieval_vector',
      operation: (queryClient) => {
        seen.push(queryClient);
        return Promise.resolve('ok');
      },
    });
    expect(result).toBe('ok');
    expect(seen).toHaveLength(1);
    const statements = statementsOf(executed);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('SET LOCAL statement_timeout');
    expect(statements[0]).toContain('4000ms');
  });

  it('issues the lexical ceiling for retrieval_lexical and honors overrides', async () => {
    const { client, executed } = makeTransactionCapableClient();
    await executeDatabaseCancelable({
      client,
      queryClass: 'retrieval_lexical',
      timeoutOverrides: { retrieval_lexical: 1_500 },
      operation: () => Promise.resolve('ok'),
    });
    const statements = statementsOf(executed);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('1500ms');
  });

  it('runs without a per-class ceiling when the client exposes only execute', async () => {
    const executed: unknown[] = [];
    const client = {
      execute: (query: unknown) => {
        executed.push(query);
        return Promise.resolve({ rows: [] });
      },
    };
    const result = await executeDatabaseCancelable({
      client: client as never,
      queryClass: 'retrieval_vector',
      operation: () => Promise.resolve('fallback-ok'),
    });
    expect(result).toBe('fallback-ok');
    expect(executed).toHaveLength(0);
  });

  it('issues no SET LOCAL when queryClass is absent (existing behavior preserved)', async () => {
    const { client, executed } = makeTransactionCapableClient();
    const result = await executeDatabaseCancelable({
      client,
      operation: () => Promise.resolve('plain-ok'),
    });
    expect(result).toBe('plain-ok');
    expect(executed).toHaveLength(0);
  });

  it('rejects an unknown query class instead of running without a timeout', async () => {
    const { client } = makeTransactionCapableClient();
    await expect(executeDatabaseCancelable({
      client,
      queryClass: 'history_telemetry_nope' as never,
      operation: () => Promise.resolve('unreachable'),
    })).rejects.toThrow();
  });
});

async function databaseReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

const databaseSuite = await databaseReachable() ? describe : describe.skip;

databaseSuite('executeDatabaseCancelable (real PostgreSQL)', () => {
  it('cancels pg_sleep on the server, leaves no active query, and keeps the pool healthy', async () => {
    const probe = `destr_cancel_probe_${Date.now()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const startedAt = performance.now();
      const result = executeDatabaseCancelable({
        client: db,
        signal: controller.signal,
        operation: (client) => client.execute(sql.raw(`SELECT pg_sleep(10) /* ${probe} */`)),
      });
      const timer = setTimeout(() => controller.abort(new Error('test cancellation')), 100);
      await expect(result).rejects.toBeInstanceOf(DatabaseQueryCancelledError);
      clearTimeout(timer);
      expect(performance.now() - startedAt).toBeLessThan(3_000);

      const active = await db.execute(sql`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state = 'active'
          AND query LIKE ${`%${probe}%`}
      `) as unknown as { rows: Array<{ count: number }> };
      expect(Number(active.rows[0]?.count ?? -1)).toBe(0);
    }

    const healthy = await db.execute(sql`SELECT 1::int AS value`) as unknown as {
      rows: Array<{ value: number }>;
    };
    expect(Number(healthy.rows[0]?.value)).toBe(1);
  }, 15_000);
});
