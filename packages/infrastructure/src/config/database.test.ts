import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EnvSource } from '@app/domain';
import {
  DEFAULT_DATABASE_POOL_SIZE,
  DEFAULT_NEON_PRODUCTION_POOL_SIZE,
  MAX_DATABASE_POOL_SIZE,
  parseDatabaseConfig,
  resetNonPooledNeonWarnings,
} from './database';

function makeEnv(values: Record<string, string | undefined>): EnvSource {
  return { get: (key) => values[key] };
}

describe('parseDatabaseConfig', () => {
  beforeEach(() => {
    resetNonPooledNeonWarnings();
  });

  it('reads each database setting through the injected source once', () => {
    const reads = new Map<string, number>();
    const env: EnvSource = {
      get: (key) => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return {
          DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
          DATABASE_POOL_MAX: '7',
          NODE_ENV: 'production',
        }[key];
      },
    };

    const config = parseDatabaseConfig(env);

    expect(config.poolMax).toBe(7);
    expect(reads.get('DATABASE_URL')).toBe(1);
    expect(reads.get('DATABASE_POOL_MAX')).toBe(1);
    expect(reads.get('NODE_ENV')).toBe(1);
  });

  it('fails clearly and redacts credentials for malformed URLs', () => {
    expect(() => parseDatabaseConfig(makeEnv({ DATABASE_URL: 'postgres user:secret@host/db' }))).toThrow(
      /Invalid DATABASE_URL/,
    );
    try {
      parseDatabaseConfig(makeEnv({ DATABASE_URL: 'postgres user:secret@host/db' }));
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).not.toContain('secret');
        expect(error.message).toContain('****');
      }
    }
  });

  it('uses the documented defaults and clamps an oversized pool once', () => {
    const warningLogger = { warn: vi.fn() };
    const prodNeon = parseDatabaseConfig(
      makeEnv({
        DATABASE_URL: 'postgres://user:pass@ep-example-pooler.us-east-1.aws.neon.tech/db?sslmode=verify-full',
        NODE_ENV: 'production',
      }),
      { warningLogger },
    );
    expect(prodNeon.poolMax).toBe(DEFAULT_NEON_PRODUCTION_POOL_SIZE);

    const clamped = parseDatabaseConfig(
      makeEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        DATABASE_POOL_MAX: '999',
      }),
      { warningLogger },
    );
    expect(clamped.poolMax).toBe(MAX_DATABASE_POOL_SIZE);
    expect(warningLogger.warn).toHaveBeenCalledTimes(1);

    const fallback = parseDatabaseConfig(makeEnv({ DATABASE_URL: 'postgres://user:pass@localhost:5432/db' }));
    expect(fallback.poolMax).toBe(DEFAULT_DATABASE_POOL_SIZE);
  });

  it('falls back for invalid pool values and reports the policy once', () => {
    const warningLogger = { warn: vi.fn() };
    const config = parseDatabaseConfig(
      makeEnv({
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        DATABASE_POOL_MAX: '-1',
      }),
      { warningLogger },
    );
    expect(config.poolMax).toBe(DEFAULT_DATABASE_POOL_SIZE);
    expect(warningLogger.warn).toHaveBeenCalledOnce();
  });

  it('normalizes Neon TLS policy while preserving secure URLs', () => {
    const secure = 'postgres://user:pass@ep-example-pooler.us-east-1.aws.neon.tech/db?sslmode=verify-full';
    const secureConfig = parseDatabaseConfig(makeEnv({ DATABASE_URL: secure }));
    expect(secureConfig.databaseUrl).toBe(secure);
    expect(secureConfig.sslMode).toBe('verify-full');

    const absentMode = parseDatabaseConfig(makeEnv({
      DATABASE_URL: 'postgres://user:pass@ep-example.us-east-1.aws.neon.tech/db',
    }));
    expect(new URL(absentMode.databaseUrl ?? '').searchParams.get('sslmode')).toBe('verify-full');

    for (const mode of ['disable', 'allow']) {
      expect(() => parseDatabaseConfig(makeEnv({
        DATABASE_URL: `postgres://user:secret@ep-example.us-east-1.aws.neon.tech/db?sslmode=${mode}`,
      }))).toThrow(/sslmode=/);
    }
  });

  it('keeps non-Neon PostgreSQL URLs supported', () => {
    const url = 'postgres://user:pass@localhost:5432/db?sslmode=require';
    const config = parseDatabaseConfig(makeEnv({ DATABASE_URL: url }));
    expect(config.databaseUrl).toBe(url);
    expect(config.isNeon).toBe(false);
    expect(config.sslMode).toBe('require');
  });

  it('deduplicates non-pooled Neon warnings by normalized host', () => {
    const warningLogger = { warn: vi.fn() };
    const first = parseDatabaseConfig(
      makeEnv({
        DATABASE_URL: 'postgres://first:secret@EP-EXAMPLE.us-east-1.aws.neon.tech/db',
        NODE_ENV: 'production',
      }),
      { warningLogger },
    );
    const second = parseDatabaseConfig(
      makeEnv({
        DATABASE_URL: 'postgres://second:other-secret@ep-example.us-east-1.aws.neon.tech/db?sslmode=verify-full',
        NODE_ENV: 'production',
      }),
      { warningLogger },
    );

    expect(first.isPooledNeon).toBe(false);
    expect(second.isPooledNeon).toBe(false);
    expect(warningLogger.warn).toHaveBeenCalledOnce();
    expect(warningLogger.warn.mock.calls[0]?.[1]).toMatchObject({ host: 'ep-example.us-east-1.aws.neon.tech' });
    expect(JSON.stringify(warningLogger.warn.mock.calls[0])).not.toContain('secret');
    expect(JSON.stringify(warningLogger.warn.mock.calls[0])).not.toContain('other-secret');
  });
});
