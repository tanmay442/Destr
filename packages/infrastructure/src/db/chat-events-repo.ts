import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from './client';
import { chatEvents, auditDeadLetter, type NewChatEvent } from './schema';
import type {
  ChatEventsRepo,
  ChatEventInput,
  ChatEventMetrics,
  ChatEventDailyUsage,
  ChatEventRange,
} from '@app/domain';

type Client = typeof db;

const MAX_BUFFER = 100;
const FLUSH_INTERVAL_MS = 5_000;

function toRow(event: ChatEventInput): NewChatEvent {
  return {
    userId: event.userId,
    query: event.query,
    mode: event.mode,
    retrieveMs: event.retrieveMs ?? null,
    generateMs: event.generateMs ?? null,
    totalMs: event.totalMs ?? null,
    hitCount: event.hitCount ?? null,
    maxSimilarity: event.maxSimilarity ?? null,
    outOfDomain: event.outOfDomain ?? false,
    hallucinationBlocked: event.hallucinationBlocked ?? false,
    cacheHit: event.cacheHit ?? false,
    ticketCreated: event.ticketCreated ?? false,
    citationCount: event.citationCount ?? null,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
    meta: event.meta ?? {},
  };
}

function rangeWhere(range?: ChatEventRange) {
  const parts = [];
  if (range?.from) parts.push(gte(chatEvents.createdAt, range.from));
  if (range?.to) parts.push(lte(chatEvents.createdAt, range.to));
  return parts.length ? and(...parts) : undefined;
}

export class ChatEventBatcher implements ChatEventsRepo {
  private buffer: NewChatEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: Client = db) {}

  record(event: ChatEventInput): void {
    this.buffer.push(toRow(event));
    if (this.buffer.length >= MAX_BUFFER) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;
    try {
      await this.client.insert(chatEvents).values(batch);
    } catch (e) {
      try {
        await this.client.insert(auditDeadLetter).values({
          kind: 'chat_event',
          payload: batch,
          error: e instanceof Error ? e.message : String(e),
        });
      } catch {
        // A dead-letter outage must never surface on the request path.
      }
    }
  }

  async getMetrics(range?: ChatEventRange): Promise<ChatEventMetrics> {
    const where = rangeWhere(range);
    const [row] = await this.client
      .select({
        total: sql<number>`count(*)::int`,
        ticketsCreated: sql<number>`count(*) filter (where ${chatEvents.ticketCreated})::int`,
        outOfDomain: sql<number>`count(*) filter (where ${chatEvents.outOfDomain})::int`,
        zeroResult: sql<number>`count(*) filter (where ${chatEvents.hitCount} = 0)::int`,
        cacheHits: sql<number>`count(*) filter (where ${chatEvents.cacheHit})::int`,
        hallucinations: sql<number>`count(*) filter (where ${chatEvents.hallucinationBlocked})::int`,
        agenticTotal: sql<number>`count(*) filter (where ${chatEvents.mode} = 'agentic')::int`,
        agenticRetries: sql<number>`count(*) filter (where ${chatEvents.mode} = 'agentic' and (${chatEvents.meta} ->> 'rewritten') = 'true')::int`,
        retrieveP50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${chatEvents.retrieveMs}), 0)`,
        retrieveP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${chatEvents.retrieveMs}), 0)`,
        generateP50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${chatEvents.generateMs}), 0)`,
        generateP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${chatEvents.generateMs}), 0)`,
        totalP50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${chatEvents.totalMs}), 0)`,
        totalP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${chatEvents.totalMs}), 0)`,
        tokensIn: sql<number>`coalesce(sum(${chatEvents.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${chatEvents.tokensOut}), 0)::int`,
        uniqueUsers: sql<number>`count(distinct ${chatEvents.userId})::int`,
      })
      .from(chatEvents)
      .where(where);

    const byModeRows = await this.client
      .select({ mode: chatEvents.mode, total: sql<number>`count(*)::int` })
      .from(chatEvents)
      .where(where)
      .groupBy(chatEvents.mode);

    const total = row?.total ?? 0;
    const div = (n: number, d: number) => (d > 0 ? n / d : 0);
    return {
      total,
      ticketsCreated: row?.ticketsCreated ?? 0,
      deflectionRate: div(row?.ticketsCreated ?? 0, total),
      outOfDomainRate: div(row?.outOfDomain ?? 0, total),
      zeroResultRate: div(row?.zeroResult ?? 0, total),
      cacheHitRate: div(row?.cacheHits ?? 0, total),
      hallucinationRate: div(row?.hallucinations ?? 0, total),
      agenticRetryRate: div(row?.agenticRetries ?? 0, row?.agenticTotal ?? 0),
      retrieveP50Ms: Math.round(Number(row?.retrieveP50 ?? 0)),
      retrieveP95Ms: Math.round(Number(row?.retrieveP95 ?? 0)),
      generateP50Ms: Math.round(Number(row?.generateP50 ?? 0)),
      generateP95Ms: Math.round(Number(row?.generateP95 ?? 0)),
      totalP50Ms: Math.round(Number(row?.totalP50 ?? 0)),
      totalP95Ms: Math.round(Number(row?.totalP95 ?? 0)),
      tokensIn: row?.tokensIn ?? 0,
      tokensOut: row?.tokensOut ?? 0,
      uniqueUsers: row?.uniqueUsers ?? 0,
      byMode: byModeRows.map((r) => ({ mode: r.mode as 'agentic' | 'vector', total: r.total })),
    };
  }

  async getTopZeroResultQueries(limit: number, range?: ChatEventRange): Promise<Array<{ q: string; count: number }>> {
    const where = and(rangeWhere(range), eq(chatEvents.hitCount, 0), isNotNull(chatEvents.query));
    const rows = await this.client
      .select({ q: chatEvents.query, count: sql<number>`count(*)::int` })
      .from(chatEvents)
      .where(where)
      .groupBy(chatEvents.query)
      .orderBy(desc(sql`count(*)`))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({ q: r.q ?? '', count: r.count }));
  }

  async getUsageOverTime(days: number): Promise<ChatEventDailyUsage[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (Math.max(days, 1) - 1));
    const rows = await this.client
      .select({
        day: sql<string>`to_char(date_trunc('day', ${chatEvents.createdAt}), 'YYYY-MM-DD')`,
        total: sql<number>`count(*)::int`,
        uniqueUsers: sql<number>`count(distinct ${chatEvents.userId})::int`,
      })
      .from(chatEvents)
      .where(gte(chatEvents.createdAt, since))
      .groupBy(sql`date_trunc('day', ${chatEvents.createdAt})`)
      .orderBy(sql`date_trunc('day', ${chatEvents.createdAt})`);
    return rows.map((r) => ({ day: r.day, total: r.total, uniqueUsers: r.uniqueUsers }));
  }

  async refreshDailyStats(): Promise<void> {
    try {
      await this.client.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY chat_daily_stats`);
    } catch {
      await this.client.execute(sql`REFRESH MATERIALIZED VIEW chat_daily_stats`);
    }
  }

  async purgeOlderThan(cutoff: Date): Promise<{ deletedCount: number }> {
    const result = await this.client
      .delete(chatEvents)
      .where(lte(chatEvents.createdAt, cutoff))
      .returning({ id: chatEvents.id });
    return { deletedCount: result.length };
  }

  async purgeUserData(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.client
      .delete(chatEvents)
      .where(eq(chatEvents.userId, userId))
      .returning({ id: chatEvents.id });
    return { deletedCount: result.length };
  }

  async anonymizeUserData(userId: string): Promise<{ updatedCount: number }> {
    const result = await this.client
      .update(chatEvents)
      .set({ userId: 'REDACTED', query: null })
      .where(eq(chatEvents.userId, userId))
      .returning({ id: chatEvents.id });
    return { updatedCount: result.length };
  }
}

export function createChatEventsRepo(client: Client = db): ChatEventsRepo {
  return new ChatEventBatcher(client);
}
