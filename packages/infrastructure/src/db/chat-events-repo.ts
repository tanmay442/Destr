import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from './client';
import { chatEvents, auditDeadLetter, type NewChatEvent } from './schema';
import type {
  ChatEventsRepo,
  ChatEventInput,
  ChatEventMetrics,
  ChatEventDailyUsage,
  ChatEventRange,
  ChatDailyTrendRow,
  ModeComparison,
  CacheBusterQuery,
  QueryOutcome,
  StuckSessions,
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
        selfServe: sql<number>`count(*) filter (where not ${chatEvents.ticketCreated} and not ${chatEvents.outOfDomain})::int`,
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
      ticketCreationRate: div(row?.ticketsCreated ?? 0, total),
      selfServeSuccessRate: div(row?.selfServe ?? 0, total),
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

  async getDailyTrends(days: number): Promise<ChatDailyTrendRow[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (Math.max(days, 1) - 1));
    const result = await this.client.execute(sql`
      select
        to_char(day, 'YYYY-MM-DD') as day,
        coalesce(sum(total), 0)::int as total,
        coalesce(sum(hallucination_count), 0)::int as hallucinations,
        coalesce(sum(ood_count), 0)::int as out_of_domain,
        coalesce(sum(cache_hits), 0)::int as cache_hits,
        coalesce(sum(tickets_created), 0)::int as tickets_created,
        coalesce(sum(self_serve_count), 0)::int as self_serve,
        coalesce(sum(avg_max_similarity * total) filter (where avg_max_similarity is not null) / nullif(sum(total) filter (where avg_max_similarity is not null), 0), 0) as avg_max_similarity,
        coalesce(sum(p50_ms * total) / nullif(sum(total), 0), 0) as total_p50_ms,
        coalesce(sum(p95_ms * total) / nullif(sum(total), 0), 0) as total_p95_ms,
        coalesce(sum(retrieve_p50_ms * total) / nullif(sum(total), 0), 0) as retrieve_p50_ms,
        coalesce(sum(retrieve_p95_ms * total) / nullif(sum(total), 0), 0) as retrieve_p95_ms,
        coalesce(sum(generate_p50_ms * total) / nullif(sum(total), 0), 0) as generate_p50_ms,
        coalesce(sum(generate_p95_ms * total) / nullif(sum(total), 0), 0) as generate_p95_ms,
        coalesce(sum(total_tokens_in), 0)::int as tokens_in,
        coalesce(sum(total_tokens_out), 0)::int as tokens_out
      from chat_daily_stats
      where day >= ${since}
      group by day
      order by day
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => ({
      day: String(r.day),
      total: Number(r.total),
      hallucinations: Number(r.hallucinations),
      outOfDomain: Number(r.out_of_domain),
      cacheHits: Number(r.cache_hits),
      ticketsCreated: Number(r.tickets_created),
      selfServe: Number(r.self_serve),
      avgMaxSimilarity: Number(r.avg_max_similarity),
      totalP50Ms: Math.round(Number(r.total_p50_ms)),
      totalP95Ms: Math.round(Number(r.total_p95_ms)),
      retrieveP50Ms: Math.round(Number(r.retrieve_p50_ms)),
      retrieveP95Ms: Math.round(Number(r.retrieve_p95_ms)),
      generateP50Ms: Math.round(Number(r.generate_p50_ms)),
      generateP95Ms: Math.round(Number(r.generate_p95_ms)),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
    }));
  }

  async getModeComparison(range?: ChatEventRange): Promise<ModeComparison[]> {
    const wordCount = sql`array_length(regexp_split_to_array(btrim(${chatEvents.query}), E'\\s+'), 1)`;
    const rows = await this.client
      .select({
        mode: chatEvents.mode,
        total: sql<number>`count(*)::int`,
        avgTokens: sql<number>`coalesce(avg(coalesce(${chatEvents.tokensIn}, 0) + coalesce(${chatEvents.tokensOut}, 0)), 0)`,
        avgMaxSimilarity: sql<number>`coalesce(avg(${chatEvents.maxSimilarity}), 0)`,
        tickets: sql<number>`count(*) filter (where ${chatEvents.ticketCreated})::int`,
        hallucinations: sql<number>`count(*) filter (where ${chatEvents.hallucinationBlocked})::int`,
        totalP50: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${chatEvents.totalMs}), 0)`,
        totalP95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${chatEvents.totalMs}), 0)`,
        short: sql<number>`count(*) filter (where ${chatEvents.query} is not null and ${wordCount} <= 3)::int`,
        medium: sql<number>`count(*) filter (where ${chatEvents.query} is not null and ${wordCount} between 4 and 9)::int`,
        long: sql<number>`count(*) filter (where ${chatEvents.query} is not null and ${wordCount} >= 10)::int`,
      })
      .from(chatEvents)
      .where(rangeWhere(range))
      .groupBy(chatEvents.mode);
    const div = (n: number, d: number) => (d > 0 ? n / d : 0);
    return rows.map((r) => ({
      mode: r.mode as 'agentic' | 'vector',
      total: r.total,
      avgTokensPerQuery: Number(r.avgTokens),
      avgMaxSimilarity: Number(r.avgMaxSimilarity),
      ticketRate: div(r.tickets, r.total),
      hallucinationRate: div(r.hallucinations, r.total),
      totalP50Ms: Math.round(Number(r.totalP50)),
      totalP95Ms: Math.round(Number(r.totalP95)),
      queryLengthBuckets: { short: r.short, medium: r.medium, long: r.long },
    }));
  }

  async getCacheBusterQueries(limit: number, range?: ChatEventRange): Promise<CacheBusterQuery[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.client.execute(sql`
      select ${chatEvents.query} as query, count(*) filter (where not ${chatEvents.cacheHit})::int as misses
      from ${chatEvents}
      where ${chatEvents.query} is not null${range?.from ? sql` and ${chatEvents.createdAt} >= ${range.from}` : sql``}${range?.to ? sql` and ${chatEvents.createdAt} <= ${range.to}` : sql``}
      group by ${chatEvents.query}
      having count(*) filter (where not ${chatEvents.cacheHit}) >= 2 and count(*) filter (where ${chatEvents.cacheHit}) = 0
      order by misses desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<{ query: string; misses: number }> }).rows ?? [];
    return rows.map((r) => ({ query: r.query, misses: Number(r.misses) }));
  }

  async getQueryOutcomes(range?: ChatEventRange, limit = 2000): Promise<QueryOutcome[]> {
    const capped = Math.min(Math.max(limit, 1), 10_000);
    const result = await this.client.execute(sql`
      select ${chatEvents.query} as query, ${chatEvents.outOfDomain} as out_of_domain, ${chatEvents.ticketCreated} as ticket_created
      from ${chatEvents}
      where ${chatEvents.query} is not null${range?.from ? sql` and ${chatEvents.createdAt} >= ${range.from}` : sql``}${range?.to ? sql` and ${chatEvents.createdAt} <= ${range.to}` : sql``}
      order by ${chatEvents.createdAt} desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<{ query: string; out_of_domain: boolean; ticket_created: boolean }> }).rows ?? [];
    return rows.map((r) => ({ query: r.query, outOfDomain: Boolean(r.out_of_domain), ticketCreated: Boolean(r.ticket_created) }));
  }

  async getStuckSessions(range?: ChatEventRange): Promise<StuckSessions> {
    const result = await this.client.execute(sql`
      with turns as (
        select
          ${chatEvents.userId} as user_id,
          ${chatEvents.createdAt} as created_at,
          ${chatEvents.ticketCreated} as ticket_created,
          case
            when ${chatEvents.createdAt} - lag(${chatEvents.createdAt}) over (partition by ${chatEvents.userId} order by ${chatEvents.createdAt}) > interval '30 minutes'
              or lag(${chatEvents.createdAt}) over (partition by ${chatEvents.userId} order by ${chatEvents.createdAt}) is null
            then 1 else 0 end as is_new_session
        from ${chatEvents}
        where ${chatEvents.userId} is not null${range?.from ? sql` and ${chatEvents.createdAt} >= ${range.from}` : sql``}${range?.to ? sql` and ${chatEvents.createdAt} <= ${range.to}` : sql``}
      ),
      sessioned as (
        select user_id, created_at, ticket_created,
          sum(is_new_session) over (partition by user_id order by created_at) as session_no
        from turns
      ),
      sessions as (
        select user_id, session_no, count(*)::int as turns,
          max(created_at) as last_activity
        from sessioned
        group by user_id, session_no
        having count(*) >= 5 and not bool_or(ticket_created)
      )
      select
        (select count(*)::int from sessions) as total_count,
        user_id, session_no::int as session_no, turns,
        to_char(last_activity at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_activity
      from sessions
      order by last_activity desc
      limit 10
    `);
    const rows = (result as unknown as { rows: Array<{ total_count: number; user_id: string; session_no: number; turns: number; last_activity: string }> }).rows ?? [];
    return {
      count: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
      samples: rows.map((r) => ({
        userId: r.user_id,
        sessionNo: Number(r.session_no),
        turns: Number(r.turns),
        lastActivity: String(r.last_activity),
      })),
    };
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
