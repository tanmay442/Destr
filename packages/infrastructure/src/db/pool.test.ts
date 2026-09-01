import { afterEach, describe, expect, it } from 'vitest';
import { closePool, DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS, getPool } from './pool';

describe('database runtime pool safety', () => {
  afterEach(async () => {
    await closePool();
  });

  it('sets a server-side statement timeout on local PostgreSQL pools', () => {
    const pool = getPool('postgres://user:password@127.0.0.1:5432/database');
    expect((pool as unknown as { options: { statement_timeout: number } }).options.statement_timeout)
      .toBe(DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS);
  });

  it('sets the same statement timeout on Neon pools', () => {
    const pool = getPool('postgres://user:password@ep-example-pooler.us-east-1.aws.neon.tech/database');
    expect((pool as unknown as { options: { statement_timeout: number } }).options.statement_timeout)
      .toBe(DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS);
  });
});
