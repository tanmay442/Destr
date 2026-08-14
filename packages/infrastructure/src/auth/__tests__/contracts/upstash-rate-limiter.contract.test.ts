import { describe, expect, vi, beforeEach } from 'vitest';
import { createUpstashRateLimiter, RATE_LIMITER_LUA } from '../../upstash-rate-limiter';
import { runRateLimiterContract } from './rate-limiter-contract';

const redisEval = vi.hoisted(() => vi.fn());

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { eval: redisEval };
  }),
}));

class RedisZsetEmulator {
  private sets = new Map<string, Map<string, number>>();
  private seqs = new Map<string, number>();

  eval(script: string, keys: string[], args: number[]): [number, number] {
    expect(script).toBe(RATE_LIMITER_LUA);
    const key = keys[0]!;
    const [now, windowMs, limit] = args as [number, number, number];
    const cutoff = now - windowMs;
    const members = this.sets.get(key) ?? new Map();
    for (const [member, score] of members) {
      if (score < cutoff) members.delete(member);
    }
    const count = members.size;
    if (count >= limit) {
      const oldest = Math.min(...members.values());
      return [0, oldest];
    }
    const seq = (this.seqs.get(key) ?? 0) + 1;
    this.seqs.set(key, seq);
    members.set(`${now}:${seq}`, now);
    this.sets.set(key, members);
    return [1, limit - count - 1];
  }
}

describe('upstash rate limiter contract', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  runRateLimiterContract(() => {
    const emulator = new RedisZsetEmulator();
    redisEval.mockImplementation((script: string, keys: string[], args: number[]) =>
      emulator.eval(script, keys, args),
    );
    return createUpstashRateLimiter();
  });
});
