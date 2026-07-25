import { describe, it, expect } from 'vitest';
import { getChatAnalytics } from '../analytics';
import { unwrap, ForbiddenError } from '@app/domain';
import type { UserRepository, ChatEventsRepo, ChatEventMetrics } from '@app/domain';

const adminUsers = {
  findByClerkId: async (id: string) => (id === 'admin' ? { role: 'admin' } : { role: 'user' }),
} as unknown as UserRepository;

const metrics: ChatEventMetrics = {
  total: 100,
  ticketsCreated: 10,
  deflectionRate: 0.1,
  outOfDomainRate: 0.2,
  zeroResultRate: 0.15,
  cacheHitRate: 0.3,
  hallucinationRate: 0.05,
  agenticRetryRate: 0.25,
  retrieveP50Ms: 40,
  retrieveP95Ms: 120,
  generateP50Ms: 300,
  generateP95Ms: 900,
  totalP50Ms: 340,
  totalP95Ms: 1020,
  tokensIn: 1_000_000,
  tokensOut: 500_000,
  uniqueUsers: 12,
  byMode: [{ mode: 'vector', total: 80 }, { mode: 'agentic', total: 20 }],
};

const chatEvents = {
  getMetrics: async () => metrics,
  getTopZeroResultQueries: async () => [{ q: 'refund', count: 5 }],
  getUsageOverTime: async () => [{ day: '2026-01-01', total: 10, uniqueUsers: 3 }],
} as unknown as ChatEventsRepo;

describe('getChatAnalytics', () => {
  it('rejects a non-admin actor', async () => {
    const res = await getChatAnalytics({ actorId: 'user' }, { users: adminUsers, chatEvents });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('returns metrics, zero-result queries, usage, and an estimated cost', async () => {
    const res = await getChatAnalytics({ actorId: 'admin' }, { users: adminUsers, chatEvents });
    const value = unwrap(res);
    expect(value.total).toBe(100);
    expect(value.topZeroResultQueries).toEqual([{ q: 'refund', count: 5 }]);
    expect(value.usageOverTime).toHaveLength(1);
    expect(value.estimatedCostUsd).toBeCloseTo(0.15 + 0.3, 5);
  });
});
