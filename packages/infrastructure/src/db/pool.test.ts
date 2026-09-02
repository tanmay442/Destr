import { afterEach, describe, expect, it } from 'vitest';
import { closePool, DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS, getPool } from './pool';
import type { DatabaseConfig } from '../config/database';

function databaseConfig(poolMax: number, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    databaseUrl: 'postgres://user:password@127.0.0.1:5432/database',
    poolMax,
    isProduction: false,
    isNeon: false,
    isPooledNeon: false,
    ...overrides,
  };
}

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

  it('does not reuse a URL pool when its effective pool size changes', () => {
    const smaller = getPool(databaseConfig(2));
    const larger = getPool(databaseConfig(3));

    expect(larger).not.toBe(smaller);
    expect((smaller as unknown as { options: { max: number } }).options.max).toBe(2);
    expect((larger as unknown as { options: { max: number } }).options.max).toBe(3);
  });

  it('keeps pools isolated when the selected driver changes', () => {
    const pgPool = getPool(databaseConfig(2));
    const neonPool = getPool(databaseConfig(2, {
      isNeon: true,
      isPooledNeon: true,
      sslMode: 'verify-full',
    }));

    expect(neonPool).not.toBe(pgPool);
  });
});
