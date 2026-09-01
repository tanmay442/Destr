import { describe, expect, it } from 'vitest';
import type { AnswerCache } from '@app/domain';
import { createInMemoryAnswerCache } from '../packages/infrastructure/src/auth/in-memory-answer-cache';
import {
  makeSyntheticEmbedding,
  parseBaselineArgs,
  redactDatabaseUrl,
  runCacheLeaseProbe,
} from './scale-baseline';

function makeCache(): AnswerCache {
  const held = new Set<string>();
  let sequence = 0;
  return {
    async get() {
      return null;
    },
    async set() {
      return undefined;
    },
    lease: {
      async tryAcquire(key) {
        if (held.has(key)) return null;
        held.add(key);
        sequence += 1;
        return `token-${sequence}`;
      },
      async release(key) {
        held.delete(key);
      },
    },
  };
}

describe('scale-baseline', () => {
  it('parses reproducible diagnostic options', () => {
    expect(
      parseBaselineArgs([
        '--database-url',
        'postgres://user:secret@localhost/db',
        '--retention-days=30',
        '--page-size=25',
        '--batch-size',
        '100',
        '--iterations=2',
        '--cache-workers=8',
        '--lease-ttl-sec=5',
        '--query-timeout-ms=5000',
        '--sleep-sec=0.5',
        '--abort-after-ms=20',
        '--vector-limit=5',
        '--message-limit=10',
        '--output',
        'baseline.json',
      ]),
    ).toMatchObject({
      databaseUrl: 'postgres://user:secret@localhost/db',
      retentionDays: 30,
      pageSize: 25,
      batchSize: 100,
      iterations: 2,
      cacheWorkers: 8,
      leaseTtlSec: 5,
      queryTimeoutMs: 5000,
      sleepSec: 0.5,
      abortAfterMs: 20,
      vectorLimit: 5,
      messageLimit: 10,
      outputPath: 'baseline.json',
    });
  });

  it('rejects unknown and invalid options', () => {
    expect(() => parseBaselineArgs(['--unknown'])).toThrow(/Unknown option/);
    expect(() => parseBaselineArgs(['--batch-size=0'])).toThrow(/Invalid --batch-size/);
    expect(() => parseBaselineArgs(['--iterations=1.5'])).toThrow(/expected an integer/);
    expect(() => parseBaselineArgs(['--output'])).toThrow(/Missing value/);
  });

  it('redacts credentials from database URLs', () => {
    const redacted = redactDatabaseUrl(
      'postgres://alice:super-secret@example.test/app?sslmode=require&password=another-secret',
    );
    expect(redacted).toContain('alice@example.test');
    expect(redacted).toContain('password=%3Credacted%3E');
    expect(redacted).not.toContain('super-secret');
    expect(redacted).not.toContain('another-secret');
    expect(redactDatabaseUrl('not a URL')).toBe('<invalid DATABASE_URL>');
  });

  it('creates vectors with the requested dimension for empty databases', () => {
    expect(makeSyntheticEmbedding(3)).toBe('[0,0,0]');
    expect(makeSyntheticEmbedding(0)).toBe(`[${Array.from({ length: 768 }, () => '0').join(',')}]`);
  });

  it('measures exclusive cache lease acquisition under concurrent contenders', async () => {
    const result = await runCacheLeaseProbe(
      { cache: makeCache(), provider: 'memory', distributed: false },
      { cacheWorkers: 16, iterations: 2, leaseTtlSec: 30 },
      { keyFactory: () => 'fixed-key' },
    );
    expect(result.status).toBe('measured');
    expect(result.crossProcess).toBe(false);
    expect(result.exclusivePerRound).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds.every((round) => round.acquired === 1 && round.contended === 15 && round.errors === 0)).toBe(true);
  });

  it('reports a cache without a lease port as an explicit error', async () => {
    const cache: AnswerCache = {
      get: async () => null,
      set: async () => undefined,
    };
    const result = await runCacheLeaseProbe(
      { cache, provider: 'memory', distributed: false },
      { cacheWorkers: 2, iterations: 1, leaseTtlSec: 1 },
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not expose/);
  });

  it('prefers the current coordination port when a provider exposes it', async () => {
    const result = await runCacheLeaseProbe(
      { cache: createInMemoryAnswerCache(), provider: 'memory', distributed: false },
      { cacheWorkers: 4, iterations: 1, leaseTtlSec: 1 },
      { keyFactory: () => 'coordination-key' },
    );
    expect(result.status).toBe('measured');
    expect(result.rounds[0]).toMatchObject({ acquired: 1, contended: 3, errors: 0 });
    expect(result.rounds[0]?.releaseErrors).toBe(0);
  });
});
