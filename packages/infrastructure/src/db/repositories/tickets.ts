import { asc, desc, eq, gt, ilike, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, tickets } from '../schema';
import type { ChatEventRange, CursorContext, ListCursorCodec, TicketListCursor, TicketRepository, TicketResponseTimes, TicketRow } from '@app/domain';
import { MAX_LEGACY_LIST_OFFSET, ValidationError } from '@app/domain';
import { toSafeDatabaseId } from '../safe-id';
import type { Client } from './shared';
import { encodeRepositoryCursor, escapeLikePattern, requiredAnd, requiredOr, whereAnd } from './shared';

function toTicketRow(row: typeof tickets.$inferSelect): TicketRow {
  return {
    ...row,
    id: toSafeDatabaseId(row.id, 'tickets.id'),
    status: row.status as TicketRow['status'],
  };
}

export const ticketRepo = {
  async findByTicketId(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const row = await client.query.tickets.findFirst({ where: eq(tickets.ticketId, ticketId) });
    return row ? toTicketRow(row) : null;
  },
  async findByTicketIdForUpdate(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const [row] = await client.select().from(tickets).where(eq(tickets.ticketId, ticketId)).for('update');
    return row ? toTicketRow(row) : null;
  },
  async list(opts: {
    status?: 'created' | 'in_progress' | 'closed' | undefined;
    assignee?: string | null | undefined;
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: TicketListCursor | undefined;
    before?: TicketListCursor | undefined;
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
  }, client: Client = db): Promise<{
    rows: TicketRow[];
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }> {
    if (opts.cursor !== undefined && opts.before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const limit = Math.min(Math.max(opts.limit, 1), 500);
    const filterParts: SQL[] = [];
    if (opts.status) filterParts.push(eq(tickets.status, opts.status));
    if (opts.assignee !== undefined && opts.assignee !== null) {
      filterParts.push(eq(tickets.assignedTo, opts.assignee));
    }
    if (opts.search) filterParts.push(ilike(tickets.issue, `%${escapeLikePattern(opts.search)}%`));
    const filter = whereAnd(filterParts);
    const pageParts = [...filterParts];
    const isBackward = opts.before !== undefined;
    const position = opts.cursor ?? opts.before;
    if (position !== undefined) {
      pageParts.push(
        isBackward
          ? requiredOr(
              gt(tickets.createdAt, position.sortAt),
              requiredAnd(eq(tickets.createdAt, position.sortAt), gt(tickets.id, position.id)),
            )
          : requiredOr(
              lt(tickets.createdAt, position.sortAt),
              requiredAnd(eq(tickets.createdAt, position.sortAt), lt(tickets.id, position.id)),
            ),
      );
    }
    const pageFilter = whereAnd(pageParts);
    const query = client
      .select({
        id: tickets.id,
        ticketId: tickets.ticketId,
        userId: tickets.userId,
        name: tickets.name,
        email: tickets.email,
        issue: tickets.issue,
        status: tickets.status,
        assignedTo: tickets.assignedTo,
        notes: tickets.notes,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .where(pageFilter)
      .orderBy(
        ...(isBackward
          ? [asc(tickets.createdAt), asc(tickets.id)]
          : [desc(tickets.createdAt), desc(tickets.id)]),
      )
      .limit(limit + 1);
    const queriedRows = !isBackward && opts.cursor === undefined && opts.offset !== undefined
      ? await query.offset(Math.min(Math.max(opts.offset, 0), MAX_LEGACY_LIST_OFFSET))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit);
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(filter))[0]?.count ?? 0;
    const hasNext = isBackward ? pageRows.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (opts.cursor !== undefined || (opts.offset ?? 0) > 0) && pageRows.length > 0;
    const safePageRows = pageRows.map((row) => toTicketRow(row));
    const firstSafeRow = safePageRows[0];
    const lastSafeRow = safePageRows[safePageRows.length - 1];
    return {
      rows: safePageRows,
      total,
      nextCursor: hasNext && lastSafeRow
        ? encodeRepositoryCursor(
            { kind: 'tickets', sortAt: lastSafeRow.createdAt, id: lastSafeRow.id, total },
            opts.cursorCodec,
            opts.cursorContext,
          )
        : null,
      previousCursor: hasPrevious && firstSafeRow
        ? encodeRepositoryCursor(
            { kind: 'tickets', sortAt: firstSafeRow.createdAt, id: firstSafeRow.id, total },
            opts.cursorCodec,
            opts.cursorContext,
          )
        : null,
    };
  },
  async latest(client: Client = db): Promise<{ id: number; ticketId: string } | null> {
    const [latest] = await client
      .select({ id: tickets.id, ticketId: tickets.ticketId })
      .from(tickets)
      .orderBy(desc(tickets.id))
      .limit(1);
    return latest
      ? { id: toSafeDatabaseId(latest.id, 'tickets.id'), ticketId: latest.ticketId }
      : null;
  },
  async insert(input: { ticketId: string; userId: string; name: string; email: string; issue: string }, client: Client = db): Promise<TicketRow> {
    const [row] = await client.insert(tickets).values(input).returning();
    if (!row) throw new Error('Failed to insert ticket');
    return toTicketRow(row);
  },
  async update(ticketId: string, patch: Partial<Pick<TicketRow, 'status' | 'assignedTo' | 'notes'>>, client: Client = db): Promise<TicketRow | null> {
    if (Object.keys(patch).length === 0) return null;
    const [row] = await client.update(tickets).set(patch).where(eq(tickets.ticketId, ticketId)).returning();
    return row ? toTicketRow(row) : null;
  },
  async countAll(client: Client = db): Promise<number> {
    const [row] = await client.select({ count: sql<number>`count(*)::int` }).from(tickets);
    return row?.count ?? 0;
  },
  async countOpen(client: Client = db): Promise<number> {
    const [row] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(sql`${tickets.status} <> 'closed'`);
    return row?.count ?? 0;
  },
  async getTicketResponseTimes(range?: ChatEventRange, client: Client = db): Promise<TicketResponseTimes> {
    const whereParts: ReturnType<typeof sql>[] = [];
    if (range?.from) whereParts.push(sql`t.created_at >= ${range.from}`);
    if (range?.to) whereParts.push(sql`t.created_at <= ${range.to}`);
    const where = whereParts.length ? sql`where ${sql.join(whereParts, sql` and `)}` : sql``;
    const rows = (await client.execute(sql`
      with scoped as (
        select t.ticket_id as ticket_id, t.created_at as created_at, t.status as status
        from ${tickets} t
        ${where}
        order by t.created_at desc
        limit 5000
      ),
      changes as (
        select
          a.target_id as ticket_id,
          a.at as changed_at,
          max(a.at) over (partition by a.target_id) as last_change
        from ${auditEvents} a
        where a.kind = 'ticket'
          and a.action = 'status_change'
          and a.target_id in (select s.ticket_id from scoped s)
      ),
      firsts as (
        select
          s.ticket_id,
          s.created_at,
          min(case when s.status = 'closed' and c.changed_at = c.last_change then null else c.changed_at end) as first_change,
          max(c.changed_at) as last_change,
          bool_or(s.status = 'closed') as is_closed
        from scoped s
        left join changes c on c.ticket_id = s.ticket_id
        group by s.ticket_id, s.created_at, s.status
      )
      select
        f.ticket_id,
        extract(epoch from (f.first_change - f.created_at)) * 1000 as first_response_ms,
        case when f.is_closed and f.last_change is not null
          then extract(epoch from (f.last_change - f.created_at)) * 1000
          else null end as resolution_ms
      from firsts f
    `)) as unknown as { rows: Array<{ first_response_ms: number | null; resolution_ms: number | null }> };
    const data = rows.rows ?? [];
    const responses = data
      .map((r) => (r.first_response_ms == null ? null : Number(r.first_response_ms)))
      .filter((v): v is number => v != null);
    const resolutions = data
      .map((r) => (r.resolution_ms == null ? null : Number(r.resolution_ms)))
      .filter((v): v is number => v != null);
    return {
      medianFirstResponseMs: median(responses),
      medianResolutionMs: median(resolutions),
      respondedCount: responses.length,
      resolvedCount: resolutions.length,
    };
  },
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.round(value);
}

export function createTicketRepo(client: Client = db): TicketRepository {
  return {
    findByTicketId: (ticketId) => ticketRepo.findByTicketId(ticketId, client),
    findByTicketIdForUpdate: (ticketId) => ticketRepo.findByTicketIdForUpdate(ticketId, client),
    list: (opts) => ticketRepo.list(opts, client),
    latest: () => ticketRepo.latest(client),
    insert: (input) => ticketRepo.insert(input, client),
    update: (ticketId, patch) => ticketRepo.update(ticketId, patch, client),
    countAll: () => ticketRepo.countAll(client),
    countOpen: () => ticketRepo.countOpen(client),
    getTicketResponseTimes: (range) => ticketRepo.getTicketResponseTimes(range, client),
  };
}
