import { and, gte, lte, sql } from 'drizzle-orm';
import { db } from './client';
import { chatEvents, chatFeedback, auditEvents, tickets, users, auditDeadLetter, type NewChatEvent } from './schema';
import type {
  ChatEventsRepo,
  ChatEventInput,
  ChatEventMetrics,
  ChatEventDailyUsage,
  ChatEventRange,
  ChatDailyTrendRow,
  ModeComparison,
  CacheBusterQuery,
  DocumentUtilityRow,
  ZeroHitDocument,
  TurnsToTicket,
  TurnToTicketBucket,
} from '@app/domain';

type Client = typeof db;

const MAX_BUFFER = 100;
const FLUSH_INTERVAL_MS = 5_000;

const TURN_BUCKET_LABELS = ['1', '2', '3', '4', '5+'] as const;

const EMPTY_TURNS_BUCKETS: TurnToTicketBucket[] = TURN_BUCKET_LABELS.map((label) => ({
  label,
  turns: Number(label === '5+' ? 5 : label),
  count: 0,
}));

function bucketForTurns(turns: number): number {
  if (turns <= 1) return 0;
  if (turns >= 5) return 4;
  return turns - 1;
}

function buildTurnBuckets(firstTurns: number[]): TurnToTicketBucket[] {
  const counts = [0, 0, 0, 0, 0];
  for (const t of firstTurns) {
    if (!Number.isFinite(t) || t < 1) continue;
    counts[bucketForTurns(Math.floor(t))]! += 1;
  }
  return TURN_BUCKET_LABELS.map((label, i) => ({
    label,
    turns: Number(label === '5+' ? 5 : label),
    count: counts[i]!,
  }));
}

function toRow(event: ChatEventInput): NewChatEvent {
  return {
    turnId: event.turnId ?? null,
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

export interface ChatEventBatcherOptions {
  flushScheduler?: (fn: () => void) => void;
}

export class ChatEventBatcher implements ChatEventsRepo {
  private buffer: NewChatEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private droppedBatches = 0;

  constructor(
    private readonly client: Client = db,
    private readonly options: ChatEventBatcherOptions = {},
  ) {}

  record(event: ChatEventInput): void {
    this.buffer.push(toRow(event));
    if (this.buffer.length >= MAX_BUFFER) {
      void this.flush();
    } else if (!this.timer) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    const scheduler = this.options.flushScheduler;
    if (scheduler) {
      try {
        scheduler(() => void this.flush());
        return;
      } catch {
        // Not inside a request scope; fall back to the interval timer.
      }
    }
    this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Keep the event loop free in serverless; explicit flushes run via after().
    this.timer.unref?.();
  }

  /** Metrics counter; batches lost when both the primary and dead-letter inserts fail. */
  get droppedBatchCount(): number {
    return this.droppedBatches;
  }

  async flush(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return;
    const run = this.persist(batch);
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async persist(batch: NewChatEvent[]): Promise<void> {
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
        this.droppedBatches += 1;
      }
    }
  }

  async getMetrics(range?: ChatEventRange): Promise<ChatEventMetrics> {
    const where = rangeWhere(range);
    const [row] = await this.client
      .select({
        total: sql<number>`count(*)::int`,
        ticketsCreated: sql<number>`count(*) filter (where ${chatEvents.ticketCreated})::int`,
        selfServe: sql<number>`count(*) filter (where not ${chatEvents.ticketCreated} and not ${chatEvents.outOfDomain} and ${chatEvents.hitCount} > 0)::int`,
        outOfDomain: sql<number>`count(*) filter (where ${chatEvents.outOfDomain})::int`,
        zeroResult: sql<number>`count(*) filter (where ${chatEvents.hitCount} = 0 or ${chatEvents.hitCount} is null)::int`,
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

  async getUsageOverTime(days: number): Promise<ChatEventDailyUsage[]> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (Math.max(days, 1) - 1));
    const rows = await this.client
      .select({
        day: sql<string>`to_char(date_trunc('day', ${chatEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        total: sql<number>`count(*)::int`,
        uniqueUsers: sql<number>`count(distinct ${chatEvents.userId})::int`,
      })
      .from(chatEvents)
      .where(gte(chatEvents.createdAt, since))
      .groupBy(sql`date_trunc('day', ${chatEvents.createdAt} AT TIME ZONE 'UTC')`)
      .orderBy(sql`date_trunc('day', ${chatEvents.createdAt} AT TIME ZONE 'UTC')`);
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
    const wordCount = sql`array_length(regexp_split_to_array(NULLIF(btrim(${chatEvents.query}), ''), E'\\s+'), 1)`;
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

  async getDocumentUtility(limit: number, range?: ChatEventRange): Promise<DocumentUtilityRow[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.client.execute(sql`
      select
        d.id as document_id,
        d.file_name as file_name,
        count(*)::int as retrieval_count,
        coalesce(percentile_cont(0.95) within group (order by ${chatEvents.maxSimilarity}), 0) as p95_similarity,
        coalesce(count(*) filter (where ${chatEvents.ticketCreated})::numeric / nullif(count(*), 0), 0) as ticket_conversion_rate
      from ${chatEvents}
      cross join lateral jsonb_array_elements_text(${chatEvents.meta} -> 'documentIds') as ref(document_id)
      join documents d on d.id = ref.document_id::int and d.deleted_at is null
      where jsonb_typeof(${chatEvents.meta} -> 'documentIds') = 'array'${range?.from ? sql` and ${chatEvents.createdAt} >= ${range.from}` : sql``}${range?.to ? sql` and ${chatEvents.createdAt} <= ${range.to}` : sql``}
      group by d.id, d.file_name
      order by retrieval_count desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => ({
      documentId: Number(r.document_id),
      fileName: r.file_name === null ? null : String(r.file_name),
      retrievalCount: Number(r.retrieval_count),
      p95Similarity: Number(r.p95_similarity),
      ticketConversionRate: Number(r.ticket_conversion_rate),
    }));
  }

  async getZeroHitDocuments(limit: number): Promise<ZeroHitDocument[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    const result = await this.client.execute(sql`
      select
        d.id as document_id,
        d.file_name as file_name,
        to_char(d.uploaded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from documents d
      where d.deleted_at is null
        and not exists (
          select 1 from ${chatEvents} e
          where jsonb_typeof(e.meta -> 'documentIds') = 'array'
            and e.meta -> 'documentIds' @> to_jsonb(d.id)
        )
      order by d.uploaded_at desc
      limit ${capped}
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => ({
      documentId: Number(r.document_id),
      fileName: r.file_name === null ? null : String(r.file_name),
      createdAt: String(r.created_at),
    }));
  }

  async getTurnsToTicket(range?: ChatEventRange): Promise<TurnsToTicket> {
    const result = await this.client.execute(sql`
      with recent as (
        select
          ${chatEvents.userId} as user_id,
          ${chatEvents.createdAt} as created_at,
          ${chatEvents.ticketCreated} as ticket_created
        from ${chatEvents}
        where ${chatEvents.userId} is not null${range?.from ? sql` and ${chatEvents.createdAt} >= ${range.from}` : sql``}${range?.to ? sql` and ${chatEvents.createdAt} <= ${range.to}` : sql``}
      ),
      turns as (
        select
          user_id, created_at, ticket_created,
          case
            when created_at - lag(created_at) over (partition by user_id order by created_at) > interval '30 minutes'
              or lag(created_at) over (partition by user_id order by created_at) is null
            then 1 else 0 end as is_new_session
        from recent
      ),
      sessioned as (
        select
          user_id, created_at, ticket_created,
          sum(is_new_session) over (partition by user_id order by created_at) as session_no
        from turns
      ),
      numbered as (
        select
          user_id, session_no, ticket_created,
          row_number() over (partition by user_id, session_no order by created_at) as turn_no
        from sessioned
      ),
      sessions as (
        select user_id, session_no,
          count(*)::int as turns,
          min(turn_no) filter (where ticket_created) as first_ticket_turn
        from numbered
        group by user_id, session_no
        having bool_or(ticket_created)
      )
      select
        (select count(*)::int from sessions) as total_sessions,
        coalesce(avg(first_ticket_turn), 0)::numeric as avg_turns,
        coalesce(jsonb_agg(jsonb_build_object('turns', first_ticket_turn)), '[]'::jsonb) as first_turns
      from sessions
    `);
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
    const row = rows[0];
    if (!row) {
      return { ticketSessions: 0, avgTurns: 0, buckets: EMPTY_TURNS_BUCKETS };
    }
    const firstTurns = Array.isArray(row.first_turns)
      ? (row.first_turns as Array<{ turns: number }>).map((r) => Number(r.turns))
      : [];
    const buckets = buildTurnBuckets(firstTurns);
    const total = Number(row.total_sessions) || 0;
    const avg = Number(row.avg_turns) || 0;
    return {
      ticketSessions: total,
      avgTurns: Math.round(avg * 100) / 100,
      buckets,
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
    const result = await this.client.execute(sql`
      with removed_feedback as (
        delete from ${chatFeedback}
        where ${chatFeedback.turnId} in (
          select ${chatEvents.turnId} from ${chatEvents}
          where ${chatEvents.createdAt} <= ${cutoff} and ${chatEvents.turnId} is not null
        )
        returning ${chatFeedback.turnId}
      )
      delete from ${chatEvents}
      where ${chatEvents.createdAt} <= ${cutoff}
      returning ${chatEvents.id}
    `);
    const rows = (result as unknown as { rows: Array<{ id: number }> }).rows ?? [];
    return { deletedCount: rows.length };
  }

  async purgeUserData(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.client.execute(sql`
      with removed_feedback as (
        delete from ${chatFeedback}
        where ${chatFeedback.turnId} in (
          select ${chatEvents.turnId} from ${chatEvents}
          where ${chatEvents.userId} = ${userId} and ${chatEvents.turnId} is not null
        )
        returning ${chatFeedback.turnId}
      ),
      removed_events as (
        delete from ${chatEvents}
        where ${chatEvents.userId} = ${userId}
        returning ${chatEvents.id}
      ),
      removed_tickets as (
        delete from ${tickets}
        where ${tickets.userId} = ${userId}
        returning ${tickets.id}
      ),
      removed_audit as (
        delete from ${auditEvents}
        where ${auditEvents.actorId} = ${userId}
          or ${auditEvents.targetId} = ${userId}
          or (${auditEvents.kind} = 'ticket' and ${auditEvents.targetId} in (
            select ${tickets.ticketId} from ${tickets} where ${tickets.userId} = ${userId}
          ))
        returning ${auditEvents.id}
      ),
      removed_user as (
        delete from ${users}
        where ${users.clerkUserId} = ${userId}
        returning ${users.clerkUserId}
      )
      select id from removed_events
    `);
    const rows = (result as unknown as { rows: Array<{ id: number }> }).rows ?? [];
    return { deletedCount: rows.length };
  }

  async anonymizeUserData(userId: string): Promise<{ updatedCount: number }> {
    const result = await this.client.execute(sql`
      with redacted_events as (
        update ${chatEvents}
        set
          user_id = null,
          query = null,
          meta = ${chatEvents.meta} - 'documentIds' - 'ticketId'
        where ${chatEvents.userId} = ${userId}
        returning ${chatEvents.id}
      ),
      redacted_tickets as (
        update ${tickets}
        set
          name = 'REDACTED',
          email = 'REDACTED',
          issue = 'REDACTED'
        where ${tickets.userId} = ${userId}
        returning ${tickets.id}
      ),
      redacted_user as (
        update ${users}
        set
          name = null,
          image_url = null,
          last_seen_at = null,
          email = 'REDACTED-' || ${userId} || '@redacted.invalid'
        where ${users.clerkUserId} = ${userId}
        returning ${users.clerkUserId}
      ),
      scrubbed_audit as (
        update ${auditEvents}
        set details = '{}'
        where ${auditEvents.actorId} = ${userId}
          or ${auditEvents.targetId} = ${userId}
          or (${auditEvents.kind} = 'ticket' and ${auditEvents.targetId} in (
            select ${tickets.ticketId} from ${tickets} where ${tickets.userId} = ${userId}
          ))
        returning ${auditEvents.id}
      )
      select id from redacted_events
    `);
    const rows = (result as unknown as { rows: Array<{ id: number }> }).rows ?? [];
    return { updatedCount: rows.length };
  }
}

export function createChatEventsRepo(client: Client = db, options: ChatEventBatcherOptions = {}): ChatEventsRepo {
  return new ChatEventBatcher(client, options);
}
