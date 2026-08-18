import { describe, it, expect } from 'vitest';
import { getChatAnalytics, getAnalyticsTrends, getDocumentAnalytics, getTicketIntelligence } from '../analytics';
import { unwrap, ForbiddenError } from '@app/domain';
import type { UserRepository, ChatEventsRepo, ChatFeedbackRepo, ChatEventMetrics, ChatDailyTrendRow, TicketRepository, TurnsToTicket, TicketResponseTimes } from '@app/domain';

const adminUsers = {
  findByClerkId: async (id: string) => (id === 'admin' ? { role: 'admin' } : { role: 'user' }),
} as unknown as UserRepository;

const metrics: ChatEventMetrics = {
  total: 100,
  ticketsCreated: 10,
  ticketCreationRate: 0.1,
  selfServeSuccessRate: 0.7,
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
  getUsageOverTime: async () => [{ day: '2026-01-01', total: 10, uniqueUsers: 3 }],
  getModeComparison: async () => [],
  getCacheBusterQueries: async () => [{ query: 'reset key', misses: 4 }],
} as unknown as ChatEventsRepo;

describe('getChatAnalytics', () => {
  it('rejects a non-admin actor', async () => {
    const res = await getChatAnalytics({ actorId: 'user' }, { users: adminUsers, chatEvents });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('returns metrics, usage, and an estimated cost', async () => {
    const res = await getChatAnalytics({ actorId: 'admin' }, { users: adminUsers, chatEvents });
    const value = unwrap(res);
    expect(value.total).toBe(100);
    expect(value.ticketCreationRate).toBe(0.1);
    expect(value.selfServeSuccessRate).toBe(0.7);
    expect(value.usageOverTime).toHaveLength(1);
    expect(value.estimatedCostUsd).toBeCloseTo(0.15 + 0.3, 5);
    expect(value.cacheBusterQueries).toEqual([{ query: 'reset key', misses: 4 }]);
  });

  it('clamps usageDays into the supported range before querying', async () => {
    const requested: number[] = [];
    const repo = {
      getMetrics: async () => metrics,
      getUsageOverTime: async (days: number) => {
        requested.push(days);
        return [];
      },
      getModeComparison: async () => [],
      getCacheBusterQueries: async () => [],
    } as unknown as ChatEventsRepo;

    await getChatAnalytics({ actorId: 'admin', usageDays: 5000 }, { users: adminUsers, chatEvents: repo });
    await getChatAnalytics({ actorId: 'admin', usageDays: -3 }, { users: adminUsers, chatEvents: repo });
    await getChatAnalytics({ actorId: 'admin', usageDays: 30 }, { users: adminUsers, chatEvents: repo });
    await getChatAnalytics({ actorId: 'admin' }, { users: adminUsers, chatEvents: repo });
    expect(requested).toEqual([1095, 1, 30, 7]);
  });
});

describe('getDocumentAnalytics', () => {
  const documentChatEvents = {
    getDocumentUtility: async () => [
      { documentId: 1, fileName: 'a.pdf', retrievalCount: 5, p95Similarity: 0.8, ticketConversionRate: 0.2 },
    ],
    getZeroHitDocuments: async () => [
      { documentId: 2, fileName: 'b.pdf', createdAt: '2026-01-01T00:00:00Z' },
    ],
  } as unknown as ChatEventsRepo;

  const feedback = {
    getFeedbackSummary: async () => ({ up: 8, down: 2, total: 10, totalEvents: 40 }),
    getDocumentSentiment: async () => [{ documentId: 1, fileName: 'a.pdf', up: 6, down: 1 }],
    getThumbsDownDocs: async () => [{ documentId: 3, fileName: 'c.pdf', down: 4 }],
  } as unknown as ChatFeedbackRepo;

  it('rejects a non-admin actor', async () => {
    const res = await getDocumentAnalytics(
      { actorId: 'user' },
      { users: adminUsers, chatEvents: documentChatEvents, feedback },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('returns utility, zero-hit and feedback sections for an admin', async () => {
    const value = unwrap(
      await getDocumentAnalytics(
        { actorId: 'admin', limit: 10 },
        { users: adminUsers, chatEvents: documentChatEvents, feedback },
      ),
    );
    expect(value.utility).toHaveLength(1);
    expect(value.zeroHit[0]!.documentId).toBe(2);
    expect(value.feedback.summary).toEqual({ up: 8, down: 2, total: 10, totalEvents: 40 });
    expect(value.feedback.documentSentiment[0]!.up).toBe(6);
    expect(value.feedback.thumbsDownDocs[0]!.down).toBe(4);
  });
});

describe('getTicketIntelligence', () => {
  const turnsToTicket: TurnsToTicket = {
    ticketSessions: 3,
    avgTurns: 2.33,
    buckets: [
      { label: '1', turns: 1, count: 1 },
      { label: '2', turns: 2, count: 1 },
      { label: '3', turns: 3, count: 1 },
      { label: '4', turns: 4, count: 0 },
      { label: '5+', turns: 5, count: 0 },
    ],
  };
  const responseTimes: TicketResponseTimes = {
    medianFirstResponseMs: 3600_000,
    medianResolutionMs: 86_400_000,
    respondedCount: 2,
    resolvedCount: 1,
  };
  const ticketChatEvents = {
    getTurnsToTicket: async () => turnsToTicket,
  } as unknown as ChatEventsRepo;
  const ticketRepo = {
    getTicketResponseTimes: async () => responseTimes,
  } as unknown as TicketRepository;

  it('rejects a non-admin actor', async () => {
    const res = await getTicketIntelligence(
      { actorId: 'user' },
      { users: adminUsers, chatEvents: ticketChatEvents, tickets: ticketRepo },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('returns turns-to-ticket and response times for an admin', async () => {
    const res = await getTicketIntelligence(
      { actorId: 'admin' },
      { users: adminUsers, chatEvents: ticketChatEvents, tickets: ticketRepo },
    );
    const value = unwrap(res);
    expect(value.turnsToTicket.ticketSessions).toBe(3);
    expect(value.responseTimes.respondedCount).toBe(2);
    expect(value.responseTimes.medianResolutionMs).toBe(86_400_000);
  });
});

describe('getAnalyticsTrends', () => {
  const trendRow = (over: Partial<ChatDailyTrendRow>): ChatDailyTrendRow => ({
    day: '2026-01-01',
    total: 0,
    hallucinations: 0,
    outOfDomain: 0,
    cacheHits: 0,
    ticketsCreated: 0,
    selfServe: 0,
    avgMaxSimilarity: 0,
    totalP50Ms: 0,
    totalP95Ms: 0,
    retrieveP50Ms: 0,
    retrieveP95Ms: 0,
    generateP50Ms: 0,
    generateP95Ms: 0,
    tokensIn: 0,
    tokensOut: 0,
    ...over,
  });

  it('rejects a non-admin actor', async () => {
    const res = await getAnalyticsTrends({ actorId: 'user' }, { users: adminUsers, chatEvents });
    expect(res.ok).toBe(false);
  });

  it('defaults to 84 days when unspecified', async () => {
    let requestedDays = 0;
    const repo = {
      getDailyTrends: async (days: number) => {
        requestedDays = days;
        return [] as ChatDailyTrendRow[];
      },
    } as unknown as ChatEventsRepo;
    const res = unwrap(await getAnalyticsTrends({ actorId: 'admin' }, { users: adminUsers, chatEvents: repo }));
    expect(requestedDays).toBe(84);
    expect(res.days).toBe(84);
    expect(res.points).toEqual([]);
  });

  it('clamps trend days into the supported range', async () => {
    const requested: number[] = [];
    const repo = {
      getDailyTrends: async (days: number) => {
        requested.push(days);
        return [];
      },
    } as unknown as ChatEventsRepo;

    await getAnalyticsTrends({ actorId: 'admin', days: 10_000 }, { users: adminUsers, chatEvents: repo });
    await getAnalyticsTrends({ actorId: 'admin', days: 0 }, { users: adminUsers, chatEvents: repo });
    await getAnalyticsTrends({ actorId: 'admin', days: 5 }, { users: adminUsers, chatEvents: repo });
    expect(requested).toEqual([1095, 84, 5]);
  });

  it('computes rates with division-by-zero safety', async () => {
    const repo = {
      getDailyTrends: async () => [
        trendRow({ day: '2026-01-01', total: 0, hallucinations: 0, ticketsCreated: 0 }),
        trendRow({
          day: '2026-01-02',
          total: 200,
          hallucinations: 10,
          outOfDomain: 40,
          cacheHits: 100,
          ticketsCreated: 20,
          selfServe: 140,
          avgMaxSimilarity: 0.7,
        }),
      ],
    } as unknown as ChatEventsRepo;
    const res = unwrap(await getAnalyticsTrends({ actorId: 'admin' }, { users: adminUsers, chatEvents: repo }));
    expect(res.points[0]!.hallucinationRate).toBe(0);
    expect(res.points[0]!.selfServeSuccessRate).toBe(0);
    expect(res.points[1]!.hallucinationRate).toBeCloseTo(0.05, 5);
    expect(res.points[1]!.outOfDomainRate).toBeCloseTo(0.2, 5);
    expect(res.points[1]!.cacheHitRate).toBeCloseTo(0.5, 5);
    expect(res.points[1]!.ticketCreationRate).toBeCloseTo(0.1, 5);
    expect(res.points[1]!.selfServeSuccessRate).toBeCloseTo(0.7, 5);
  });
});
