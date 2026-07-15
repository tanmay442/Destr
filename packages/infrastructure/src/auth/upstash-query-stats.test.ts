import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createUpstashQueryStats } from './upstash-query-stats';

const createRedisMock = () => ({
  zincrby: vi.fn(),
  zrange: vi.fn(),
});

let redisMock = createRedisMock();

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return redisMock;
  }),
}));

describe('createUpstashQueryStats', () => {
  beforeEach(() => {
    redisMock = createRedisMock();
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when env vars are missing', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    expect(() => createUpstashQueryStats()).toThrow('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
  });

  it('records a normalized query via zincrby', async () => {
    redisMock.zincrby.mockResolvedValue(1);
    const stats = createUpstashQueryStats();
    await stats.record('user:1', '  How do I reset my password?  ');

    expect(redisMock.zincrby).toHaveBeenCalledWith('query:global', 1, 'how do i reset my password?');
  });

  it('ignores empty queries', async () => {
    const stats = createUpstashQueryStats();
    await stats.record('user:1', '   ');

    expect(redisMock.zincrby).not.toHaveBeenCalled();
  });

  it('returns the top queries from a sorted set', async () => {
    redisMock.zrange.mockResolvedValue([
      { member: 'password reset', score: 5 },
      { member: 'pto policy', score: 2 },
    ]);
    const stats = createUpstashQueryStats();
    const top = await stats.top(10);

    expect(redisMock.zrange).toHaveBeenCalledWith('query:global', 0, 9, { rev: true, withScores: true });
    expect(top).toEqual([
      { q: 'password reset', count: 5 },
      { q: 'pto policy', count: 2 },
    ]);
  });
});
