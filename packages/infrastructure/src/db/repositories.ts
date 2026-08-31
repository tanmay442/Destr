import { eq, desc, asc, gt, ilike, or, sql, isNull, and, lt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from './client';
import {
  documents,
  tickets,
  users,
  auditEvents,
  auditDeadLetter,
  chatEvents,
  chatConversations,
  qualityReviews,
  appSettings,
  type Document,
} from './schema';
import type {
  TicketRow,
  UserRow,
  IngestStatus,
  AuditEventInput,
  AuditEventRecord,
  AuditKind,
  AuditListFilter,
  TicketResponseTimes,
  ChatEventRange,
  DocumentListCursor,
  Hasher,
  TicketListCursor,
  UserListCursor,
} from '@app/domain';
import { ValidationError, MAX_LIST_LIMIT, MAX_AUDIT_LIMIT, encodeListCursor, logger } from '@app/domain';
import { createChunkStore, countChunksForDocuments, countChunksForAll } from './chunk-store';
import { defaultHasher } from './stable-identities';
import { createVectorSearch } from './vector-search';
import { createLexicalSearch } from './lexical-search';
import { resolveVectorDim } from './schema-vector';
import { invalidateRoleCache } from '../auth/role-cache';

export { searchChunksByVector } from './vector-search';
export { searchChunksByLexical } from './lexical-search';
export {
  insertChunks,
  replaceChunks,
  getChunksByIds,
  getChunksByDocAndRange,
  getChunksByDocAndRanges,
  deleteChunksByDocumentId,
  countChunksForDocuments,
  countChunksForAll,
  countChunksForDocument,
  recountChunksForAll,
} from './chunk-store';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function whereAnd(parts: SQL[]) {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

function requiredOr(...parts: SQL[]): SQL {
  const condition = or(...parts);
  if (condition === undefined) throw new Error('Expected at least one SQL condition');
  return condition;
}

function requiredAnd(...parts: SQL[]): SQL {
  const condition = and(...parts);
  if (condition === undefined) throw new Error('Expected at least one SQL condition');
  return condition;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function findDocumentByName(
  name: string,
  client: Client = db,
  opts: { includeDeleted?: boolean | undefined } = {},
): Promise<Document | null> {
  const parts = [eq(documents.fileName, name)];
  if (!opts.includeDeleted) parts.push(isNull(documents.deletedAt));
  const row = await client.query.documents.findFirst({
    where: whereAnd(parts),
    orderBy: (table, { desc: orderByDesc }) => [orderByDesc(table.deletedAt)],
  });
  return (row as Document | undefined) ?? null;
}

export async function findDocumentByNameForUpdate(
  name: string,
  client: Client = db,
  opts?: { includeDeleted?: boolean | undefined },
): Promise<Document | null> {
  const where = opts?.includeDeleted
    ? eq(documents.fileName, name)
    : and(eq(documents.fileName, name), isNull(documents.deletedAt));
  const [row] = await client
    .select()
    .from(documents)
    .where(where)
    .orderBy(sql`${documents.deletedAt} IS NULL DESC`, desc(documents.deletedAt))
    .limit(1)
    .for('update');
  return (row as Document | undefined) ?? null;
}

export async function findDocumentById(
  id: number,
  client: Client = db,
  opts: { includeDeleted?: boolean | undefined } = {},
): Promise<Document | null> {
  const parts = [eq(documents.id, id)];
  if (!opts.includeDeleted) parts.push(isNull(documents.deletedAt));
  const row = await client.query.documents.findFirst({ where: whereAnd(parts) });
  return (row as Document | undefined) ?? null;
}

export async function insertDocument(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client = db,
  opts: { resurrectDeleted?: boolean | undefined } = {},
): Promise<Document> {
  return tryInsert(input, client, opts.resurrectDeleted ?? true);
}

async function tryInsert(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client,
  resurrectDeleted: boolean,
): Promise<Document> {
  const existing = await client.query.documents.findFirst({
    where: eq(documents.fileName, input.fileName),
    orderBy: (table, { desc: orderByDesc }) => [orderByDesc(table.deletedAt)],
  });
  if (existing && existing.deletedAt == null) {
    const [row] = await client
      .update(documents)
      .set({ fileHash: input.fileHash, uploadedBy: input.uploadedBy })
      .where(eq(documents.id, existing.id))
      .returning();
    if (!row) throw new Error('Failed to insert document');
    return row as Document;
  }
  if (existing && existing.deletedAt != null && resurrectDeleted) {
    const existingId = existing.id;
    const resurrect = async () => {
      const [row] = await client
        .update(documents)
        .set({
          fileHash: input.fileHash,
          uploadedBy: input.uploadedBy,
          deletedAt: null,
          ingestStatus: 'done',
          ingestUpdatedAt: new Date(),
        })
        .where(eq(documents.id, existingId))
        .returning();
      if (!row) throw new Error('Failed to insert document');
      return row as Document;
    };
    if (client === db) return db.transaction(resurrect);
    return resurrect();
  }
  const [row] = await client.insert(documents).values(input).returning();
  if (!row) throw new Error('Failed to insert document');
  return row as Document;
}

export async function updateDocument(
  id: number,
  patch: {
    fileName?: string;
    fileHash?: string;
    uploadedBy?: string;
    ingestStatus?: IngestStatus;
    storageKey?: string | null;
  },
  client: Client = db,
): Promise<Document> {
  const update = patch.ingestStatus === undefined
    ? patch
    : { ...patch, ingestUpdatedAt: new Date() };
  const [row] = await client.update(documents).set(update).where(eq(documents.id, id)).returning();
  if (!row) throw new Error(`Failed to update document ${id}`);
  return row as Document;
}

export async function updateDocumentIfCurrent(
  id: number,
  expectedFileHash: string,
  patch: {
    fileName?: string;
    fileHash?: string;
    uploadedBy?: string;
    ingestStatus?: IngestStatus;
    storageKey?: string | null;
  },
  client: Client = db,
): Promise<Document | null> {
  const update = patch.ingestStatus === undefined
    ? patch
    : { ...patch, ingestUpdatedAt: new Date() };
  const [row] = await client
    .update(documents)
    .set(update)
    .where(and(eq(documents.id, id), eq(documents.fileHash, expectedFileHash), isNull(documents.deletedAt)))
    .returning();
  return (row as Document | undefined) ?? null;
}

export async function deleteDocumentById(id: number, client: Client = db): Promise<void> {
  await client.delete(documents).where(eq(documents.id, id));
}

export async function setDocumentStorageKey(id: number, key: string | null, client: Client = db): Promise<void> {
  await client.update(documents).set({ storageKey: key }).where(eq(documents.id, id));
}

export async function updateDocumentIngestStatus(
  id: number,
  status: 'queued' | 'ingesting' | 'done' | 'failed',
  client: Client = db,
): Promise<void> {
  await client.update(documents).set({ ingestStatus: status, ingestUpdatedAt: new Date() }).where(eq(documents.id, id));
}

export async function listStaleQueuedDocuments(olderThan: Date, client: Client = db): Promise<number[]> {
  const rows = await client
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        or(eq(documents.ingestStatus, 'queued'), eq(documents.ingestStatus, 'ingesting')),
        isNull(documents.deletedAt),
        lt(documents.ingestUpdatedAt, olderThan),
      ),
    );
  return rows.map((r) => r.id);
}

export async function failDocumentById(id: number, client: Client = db): Promise<void> {
  await client
    .update(documents)
    .set({ ingestStatus: 'failed', ingestUpdatedAt: new Date() })
    .where(and(
      eq(documents.id, id),
      isNull(documents.deletedAt),
      or(eq(documents.ingestStatus, 'queued'), eq(documents.ingestStatus, 'ingesting')),
    ));
}

export async function failDocumentIfStale(
  id: number,
  olderThan: Date,
  client: Client = db,
): Promise<boolean> {
  const [row] = await client
    .update(documents)
    .set({ ingestStatus: 'failed', ingestUpdatedAt: new Date() })
    .where(
      and(
        eq(documents.id, id),
        or(eq(documents.ingestStatus, 'queued'), eq(documents.ingestStatus, 'ingesting')),
        isNull(documents.deletedAt),
        lt(documents.ingestUpdatedAt, olderThan),
      ),
    )
    .returning({ id: documents.id });
  return row !== undefined;
}

export async function failDocumentIfCurrent(
  id: number,
  expectedFileHash: string,
  client: Client = db,
): Promise<boolean> {
  const [row] = await client
    .update(documents)
    .set({ ingestStatus: 'failed', ingestUpdatedAt: new Date() })
    .where(
      and(
        eq(documents.id, id),
        eq(documents.fileHash, expectedFileHash),
        isNull(documents.deletedAt),
        or(eq(documents.ingestStatus, 'queued'), eq(documents.ingestStatus, 'ingesting')),
      ),
    )
    .returning({ id: documents.id });
  return row !== undefined;
}

/** Conditional claim: flips `queued`→`ingesting` atomically; true iff a row was updated. */
export async function claimDocumentIngest(
  id: number,
  client: Client = db,
  expectedFileHash?: string,
): Promise<boolean> {
  const conditions = [eq(documents.id, id), eq(documents.ingestStatus, 'queued'), isNull(documents.deletedAt)];
  if (expectedFileHash !== undefined) conditions.push(eq(documents.fileHash, expectedFileHash));
  const [row] = await client
    .update(documents)
    .set({ ingestStatus: 'ingesting', ingestUpdatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: documents.id });
  return row !== undefined;
}

export async function updateDocumentIngestStatusIfCurrent(
  id: number,
  expectedFileHash: string,
  expectedStatus: 'queued' | 'ingesting' | 'done' | 'failed',
  nextStatus: 'queued' | 'ingesting' | 'done' | 'failed',
  client: Client = db,
): Promise<boolean> {
  const [row] = await client
    .update(documents)
    .set({ ingestStatus: nextStatus, ingestUpdatedAt: new Date() })
    .where(
      and(
        eq(documents.id, id),
        eq(documents.fileHash, expectedFileHash),
        eq(documents.ingestStatus, expectedStatus),
        isNull(documents.deletedAt),
      ),
    )
    .returning({ id: documents.id });
  return row !== undefined;
}

export async function restoreDocumentAfterQueueFailure(
  id: number,
  expected: { fileHash: string; storageKey: string },
  previous: { fileHash: string | null; ingestStatus: 'queued' | 'ingesting' | 'done' | 'failed' | null; storageKey: string | null },
  client: Client = db,
): Promise<boolean> {
  const current = and(
    eq(documents.id, id),
    eq(documents.fileHash, expected.fileHash),
    eq(documents.storageKey, expected.storageKey),
    eq(documents.ingestStatus, 'queued'),
  );
  if (previous.fileHash !== null) {
    const [row] = await client
      .update(documents)
      .set({
        fileHash: previous.fileHash,
        ingestStatus: previous.ingestStatus ?? 'failed',
        storageKey: previous.storageKey,
        ingestUpdatedAt: new Date(),
      })
      .where(current)
      .returning({ id: documents.id });
    return row !== undefined;
  }
  const [row] = await client.delete(documents).where(current).returning({ id: documents.id });
  return row !== undefined;
}

export async function softDeleteDocument(id: number, at: Date, client: Client = db): Promise<Document | null> {
  const [row] = await client.update(documents).set({ deletedAt: at }).where(eq(documents.id, id)).returning();
  return (row as Document | null) ?? null;
}

export async function restoreDocument(id: number, client: Client = db): Promise<Document | null> {
  const [row] = await client.update(documents).set({ deletedAt: null }).where(eq(documents.id, id)).returning();
  return (row as Document | null) ?? null;
}

export async function listDocuments(
  opts: {
    search?: string | undefined;
    includeDeleted?: boolean | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: DocumentListCursor | undefined;
    before?: DocumentListCursor | undefined;
  },
  client: Client = db,
): Promise<{
  documents: Array<Document & { hasBlob: boolean }>;
  total: number;
  nextCursor: string | null;
  previousCursor: string | null;
}> {
  if (opts.cursor !== undefined && opts.before !== undefined) {
    throw new ValidationError('Only one pagination cursor may be provided');
  }
  const filterParts: SQL[] = [];
  if (!opts.includeDeleted) filterParts.push(isNull(documents.deletedAt));
  if (opts.search) filterParts.push(ilike(documents.fileName, `%${escapeLikePattern(opts.search)}%`));
  const filter = whereAnd(filterParts);
  const pageParts = [...filterParts];
  const isBackward = opts.before !== undefined;
  const position = opts.cursor ?? opts.before;
  if (position !== undefined) {
    pageParts.push(
      isBackward
        ? requiredOr(
            gt(documents.uploadedAt, position.sortAt),
            requiredAnd(eq(documents.uploadedAt, position.sortAt), gt(documents.id, position.id)),
          )
        : requiredOr(
            lt(documents.uploadedAt, position.sortAt),
            requiredAnd(eq(documents.uploadedAt, position.sortAt), lt(documents.id, position.id)),
          ),
    );
  }
  const pageFilter = whereAnd(pageParts);
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const query = client
    .select({
      id: documents.id,
      documentUid: documents.documentUid,
      fileName: documents.fileName,
      fileHash: documents.fileHash,
      uploadedBy: documents.uploadedBy,
      uploadedAt: documents.uploadedAt,
      storageKey: documents.storageKey,
      ingestStatus: documents.ingestStatus,
      ingestUpdatedAt: documents.ingestUpdatedAt,
      hasBlob: sql<boolean>`(${documents.storageKey} IS NOT NULL OR ${documents.blob} IS NOT NULL)`.as('hasBlob'),
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(pageFilter)
    .orderBy(
      ...(isBackward
        ? [asc(documents.uploadedAt), asc(documents.id)]
        : [desc(documents.uploadedAt), desc(documents.id)]),
    )
    .limit(limit + 1);
  const queriedRows = !isBackward && opts.cursor === undefined && opts.offset !== undefined
    ? await query.offset(Math.max(opts.offset, 0))
    : await query;
  const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
  const hasExtra = queriedRows.length > limit;
  const pageRows = isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit);
  const total = position?.total ?? (await client
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(filter))[0]?.count ?? 0;
  const firstRow = pageRows[0];
  const lastRow = pageRows[pageRows.length - 1];
  const hasNext = isBackward ? pageRows.length > 0 : hasExtra;
  const hasPrevious = isBackward
    ? hasExtra
    : (opts.cursor !== undefined || (opts.offset ?? 0) > 0) && pageRows.length > 0;
  return {
    documents: pageRows as unknown as Array<Document & { hasBlob: boolean }>,
    total,
    nextCursor: hasNext && lastRow
      ? encodeListCursor({ kind: 'documents', sortAt: lastRow.uploadedAt, id: lastRow.id, total })
      : null,
    previousCursor: hasPrevious && firstRow
      ? encodeListCursor({ kind: 'documents', sortAt: firstRow.uploadedAt, id: firstRow.id, total })
      : null,
  };
}

export const ticketRepo = {
  async findByTicketId(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const row = await client.query.tickets.findFirst({ where: eq(tickets.ticketId, ticketId) });
    return (row as TicketRow | undefined) ?? null;
  },
  async findByTicketIdForUpdate(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const [row] = await client.select().from(tickets).where(eq(tickets.ticketId, ticketId)).for('update');
    return (row as TicketRow | undefined) ?? null;
  },
  async list(opts: {
    status?: 'created' | 'in_progress' | 'closed' | undefined;
    assignee?: string | null | undefined;
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: TicketListCursor | undefined;
    before?: TicketListCursor | undefined;
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
      ? await query.offset(Math.max(opts.offset, 0))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit);
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(filter))[0]?.count ?? 0;
    const firstRow = pageRows[0];
    const lastRow = pageRows[pageRows.length - 1];
    const hasNext = isBackward ? pageRows.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (opts.cursor !== undefined || (opts.offset ?? 0) > 0) && pageRows.length > 0;
    return {
      rows: pageRows as unknown as TicketRow[],
      total,
      nextCursor: hasNext && lastRow
        ? encodeListCursor({ kind: 'tickets', sortAt: lastRow.createdAt, id: lastRow.id, total })
        : null,
      previousCursor: hasPrevious && firstRow
        ? encodeListCursor({ kind: 'tickets', sortAt: firstRow.createdAt, id: firstRow.id, total })
        : null,
    };
  },
  async latest(client: Client = db): Promise<{ id: number; ticketId: string } | null> {
    const [latest] = await client
      .select({ id: tickets.id, ticketId: tickets.ticketId })
      .from(tickets)
      .orderBy(desc(tickets.id))
      .limit(1);
    return latest ?? null;
  },
  async insert(input: { ticketId: string; userId: string; name: string; email: string; issue: string }, client: Client = db): Promise<TicketRow> {
    const [row] = await client.insert(tickets).values(input).returning();
    if (!row) throw new Error('Failed to insert ticket');
    return row as TicketRow;
  },
  async update(ticketId: string, patch: Partial<Pick<TicketRow, 'status' | 'assignedTo' | 'notes'>>, client: Client = db): Promise<TicketRow | null> {
    if (Object.keys(patch).length === 0) return null;
    const [row] = await client.update(tickets).set(patch).where(eq(tickets.ticketId, ticketId)).returning();
    return (row as TicketRow | null) ?? null;
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

// Rebinding an email to a new clerk id reassigns every record owned by the old
// identity (documents, tickets, chats, audit trail, settings). Only adopt a row
// when the email is verified AND the row is provably fresh; otherwise fail
// closed so recycled emails can never inherit another account's data or role.
async function rebindEmailIdentity(
  client: Client,
  input: { clerkUserId: string; email: string; name?: string | null; imageUrl?: string | null; emailVerified?: boolean | undefined },
): Promise<UserRow> {
  const existing = await client.query.users.findFirst({ where: eq(users.email, input.email) });
  if (!existing) {
    logger.error('[userRepo] email-conflict rebind refused: conflicting row no longer exists', {
      email: input.email,
      clerkUserId: input.clerkUserId,
    });
    throw new Error(`Cannot sync Clerk user ${input.clerkUserId}: email ${input.email} is already bound to another account; refusing to reassign it.`);
  }
  if (existing.clerkUserId === input.clerkUserId) return existing as UserRow;
  if (input.emailVerified !== true) {
    logger.error('[userRepo] email-conflict rebind refused: email not verified', {
      email: input.email,
      clerkUserId: input.clerkUserId,
      existingClerkUserId: existing.clerkUserId,
    });
    throw new Error(`Cannot sync Clerk user ${input.clerkUserId}: email ${input.email} is already bound to ${existing.clerkUserId} and email verification is not confirmed; refusing to reassign the account.`);
  }
  if (await userHasOwnedHistory(client, existing.clerkUserId)) {
    logger.error('[userRepo] email-conflict rebind refused: existing account owns data', {
      email: input.email,
      clerkUserId: input.clerkUserId,
      existingClerkUserId: existing.clerkUserId,
    });
    throw new Error(`Cannot sync Clerk user ${input.clerkUserId}: email ${input.email} is already bound to ${existing.clerkUserId} which owns data; refusing to reassign its history.`);
  }
  const [row] = await client
    .update(users)
    .set({
      clerkUserId: input.clerkUserId,
      email: input.email,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
    })
    .where(eq(users.email, input.email))
    .returning();
  if (!row) {
    logger.error('[userRepo] email-conflict rebind failed: conflicting row vanished before update', {
      email: input.email,
      clerkUserId: input.clerkUserId,
    });
    throw new Error(`Failed to reassign email ${input.email} to Clerk user ${input.clerkUserId}.`);
  }
  return row as UserRow;
}

async function userHasOwnedHistory(client: Client, clerkUserId: string): Promise<boolean> {
  if (await client.query.documents.findFirst({ where: eq(documents.uploadedBy, clerkUserId) })) return true;
  if (await client.query.tickets.findFirst({ where: eq(tickets.userId, clerkUserId) })) return true;
  if (await client.query.chatEvents.findFirst({ where: eq(chatEvents.userId, clerkUserId) })) return true;
  if (await client.query.chatConversations.findFirst({ where: eq(chatConversations.userId, clerkUserId) })) return true;
  if (await client.query.qualityReviews.findFirst({ where: eq(qualityReviews.reviewerId, clerkUserId) })) return true;
  if (
    await client.query.auditEvents.findFirst({
      where: or(
        eq(auditEvents.actorId, clerkUserId),
        and(eq(auditEvents.targetType, 'user'), eq(auditEvents.targetId, clerkUserId)),
      ),
    })
  ) return true;
  return (await client.query.appSettings.findFirst({ where: eq(appSettings.updatedBy, clerkUserId) })) != null;
}

export const userRepo = {
  async upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
    emailVerified?: boolean | undefined;
  }, client: Client = db): Promise<UserRow> {
    const run = async (tx: Client): Promise<UserRow> => {
      const [row] = await tx
        .insert(users)
        .values({
          clerkUserId: input.clerkUserId,
          email: input.email,
          name: input.name,
          imageUrl: input.imageUrl,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: users.clerkUserId,
          set: {
            email: input.email,
            role: input.role,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
          },
        })
        .returning();
      if (!row) throw new Error('Failed to upsert user');
      return row as UserRow;
    };

    try {
      return await run(client);
    } catch (err) {
      const wrapped = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      const pgErr = wrapped.code === '23505' ? wrapped : wrapped.cause;
      if (pgErr?.code === '23505' && pgErr.constraint === 'users_email_unique') {
        return rebindEmailIdentity(client, input);
      }
      throw err;
    }
  },
  async findByClerkId(clerkUserId: string, client: Client = db): Promise<UserRow | null> {
    const row = await client.query.users.findFirst({ where: eq(users.clerkUserId, clerkUserId) });
    return (row as UserRow | undefined) ?? null;
  },
  async findByIds(clerkUserIds: string[], client: Client = db): Promise<UserRow[]> {
    if (clerkUserIds.length === 0) return [];
    const rows = await client.query.users.findMany({
      where: (u, { inArray }) => inArray(u.clerkUserId, clerkUserIds),
    });
    return rows as UserRow[];
  },
  async setRole(clerkUserId: string, role: 'admin' | 'user', client: Client = db): Promise<UserRow | null> {
    const [row] = await client.update(users).set({ role }).where(eq(users.clerkUserId, clerkUserId)).returning();
    invalidateRoleCache(clerkUserId);
    return (row as UserRow | null) ?? null;
  },
  async setRoleIfCurrent(
    clerkUserId: string,
    expectedRole: 'admin' | 'user',
    role: 'admin' | 'user',
    client: Client = db,
  ): Promise<boolean> {
    const [row] = await client
      .update(users)
      .set({ role })
      .where(and(eq(users.clerkUserId, clerkUserId), eq(users.role, expectedRole)))
      .returning({ clerkUserId: users.clerkUserId });
    if (row) invalidateRoleCache(clerkUserId);
    return row !== undefined;
  },
  async touchLastSeen(clerkUserId: string, client: Client = db): Promise<void> {
    await client.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.clerkUserId, clerkUserId));
  },
  async list(opts: {
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: UserListCursor | undefined;
    before?: UserListCursor | undefined;
  }, client: Client = db): Promise<{
    rows: UserRow[];
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }> {
    if (opts.cursor !== undefined && opts.before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const search = opts.search?.trim();
    const filterParts: SQL[] = [];
    if (search) {
      filterParts.push(
        requiredOr(
          ilike(users.email, `%${escapeLikePattern(search)}%`),
          ilike(users.name, `%${escapeLikePattern(search)}%`),
        ),
      );
    }
    const filter = whereAnd(filterParts);
    const pageParts = [...filterParts];
    const isBackward = opts.before !== undefined;
    const position = opts.cursor ?? opts.before;
    if (position !== undefined) {
      pageParts.push(
        isBackward
          ? requiredOr(
              lt(users.createdAt, position.sortAt),
              requiredAnd(eq(users.createdAt, position.sortAt), lt(users.clerkUserId, position.clerkUserId)),
            )
          : requiredOr(
              gt(users.createdAt, position.sortAt),
              requiredAnd(eq(users.createdAt, position.sortAt), gt(users.clerkUserId, position.clerkUserId)),
            ),
      );
    }
    const pageFilter = whereAnd(pageParts);
    const limit = Math.min(Math.max(opts.limit, 1), MAX_LIST_LIMIT);
    const query = client
      .select()
      .from(users)
      .where(pageFilter)
      .orderBy(
        ...(isBackward
          ? [desc(users.createdAt), desc(users.clerkUserId)]
          : [asc(users.createdAt), asc(users.clerkUserId)]),
      )
      .limit(limit + 1);
    const queriedRows = !isBackward && opts.cursor === undefined && opts.offset !== undefined
      ? await query.offset(Math.max(opts.offset, 0))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = (isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit)) as UserRow[];
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(filter))[0]?.count ?? 0;
    const firstRow = pageRows[0];
    const lastRow = pageRows[pageRows.length - 1];
    const hasNext = isBackward ? pageRows.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (opts.cursor !== undefined || (opts.offset ?? 0) > 0) && pageRows.length > 0;
    return {
      rows: pageRows,
      total,
      nextCursor: hasNext && lastRow
        ? encodeListCursor({ kind: 'users', sortAt: lastRow.createdAt, clerkUserId: lastRow.clerkUserId, total })
        : null,
      previousCursor: hasPrevious && firstRow
        ? encodeListCursor({ kind: 'users', sortAt: firstRow.createdAt, clerkUserId: firstRow.clerkUserId, total })
        : null,
    };
  },
  async countAll(client: Client = db): Promise<number> {
    const [row] = await client.select({ count: sql<number>`count(*)::int` }).from(users);
    return row?.count ?? 0;
  },
  async countAdmins(client: Client = db): Promise<number> {
    const [row] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, 'admin'));
    return row?.count ?? 0;
  },
  async countAdminsForUpdate(client: Client = db): Promise<number> {
    const result = await client.execute(sql`
      select count(*)::int as count
      from (select 1 from ${users} where ${users.role} = 'admin' for update) locked
    `);
    const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows ?? [];
    return Number(rows[0]?.count ?? 0);
  },
};

export const auditRepo = {
  async logEvent(input: AuditEventInput, client: Client = db): Promise<void> {
    await client.insert(auditEvents).values({
      kind: input.kind,
      action: input.action,
      actorId: input.actorId,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      details: input.details ?? {},
    });
  },
  async logDocumentEvent(
    input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      { kind: 'document', action: input.action, actorId: input.actorId, targetType: 'document', targetId: String(input.documentId) },
      client,
    );
  },
  async logTicketEvent(
    input: { action: 'create' | 'assign' | 'status_change' | 'note' | 'impersonation' | 'role_change'; ticketId: string; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      { kind: 'ticket', action: input.action, actorId: input.actorId, targetType: 'ticket', targetId: input.ticketId },
      client,
    );
  },
  async logUserEvent(
    input: { targetUserId: string; actorId: string; fromRole: 'admin' | 'user'; toRole: 'admin' | 'user' },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      {
        kind: 'user',
        action: 'role_change',
        actorId: input.actorId,
        targetType: 'user',
        targetId: input.targetUserId,
        details: { fromRole: input.fromRole, toRole: input.toRole },
      },
      client,
    );
  },
  async list(input: AuditListFilter, client: Client = db): Promise<{
    events: AuditEventRecord[];
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }> {
    if (input.kind !== undefined && !['document', 'ticket', 'user', 'settings'].includes(input.kind)) {
      throw new ValidationError(`Invalid audit kind: ${input.kind}`);
    }
    if (input.kind === 'document' && input.ticketId !== undefined) {
      throw new ValidationError('Cannot filter by both kind=document and ticketId');
    }
    if (input.kind === 'ticket' && input.documentId !== undefined) {
      throw new ValidationError('Cannot filter by both kind=ticket and documentId');
    }
    if (input.documentId !== undefined && input.kind !== undefined && input.kind !== 'document') {
      throw new ValidationError('Cannot filter by documentId with kind different from document');
    }
    if (input.cursor !== undefined && input.before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const filterParts: SQL[] = [];
    if (input.kind) filterParts.push(eq(auditEvents.kind, input.kind));
    if (input.action) filterParts.push(eq(auditEvents.action, input.action));
    if (input.actorId) filterParts.push(eq(auditEvents.actorId, input.actorId));
    if (input.from) filterParts.push(sql`${auditEvents.at} >= ${input.from}`);
    if (input.to) filterParts.push(sql`${auditEvents.at} <= ${input.to}`);
    if (input.documentId !== undefined) {
      filterParts.push(eq(auditEvents.kind, 'document'), eq(auditEvents.targetId, String(input.documentId)));
    }
    if (input.ticketId !== undefined) {
      filterParts.push(eq(auditEvents.kind, 'ticket'), eq(auditEvents.targetId, input.ticketId));
    }
    const filter = whereAnd(filterParts);
    const pageParts = [...filterParts];
    const isBackward = input.before !== undefined;
    const position = input.cursor ?? input.before;
    if (position !== undefined) {
      pageParts.push(
        isBackward
          ? requiredOr(
              gt(auditEvents.at, position.sortAt),
              requiredAnd(eq(auditEvents.at, position.sortAt), gt(auditEvents.id, position.id)),
            )
          : requiredOr(
              lt(auditEvents.at, position.sortAt),
              requiredAnd(eq(auditEvents.at, position.sortAt), lt(auditEvents.id, position.id)),
            ),
      );
    }
    const pageFilter = whereAnd(pageParts);
    const limit = Math.min(Math.max(input.limit, 1), MAX_AUDIT_LIMIT);
    const query = client
      .select({
        id: auditEvents.id,
        kind: auditEvents.kind,
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        actorName: users.name,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        details: auditEvents.details,
        at: auditEvents.at,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.clerkUserId, auditEvents.actorId))
      .where(pageFilter)
      .orderBy(
        ...(isBackward
          ? [asc(auditEvents.at), asc(auditEvents.id)]
          : [desc(auditEvents.at), desc(auditEvents.id)]),
      )
      .limit(limit + 1);
    const queriedRows = !isBackward && input.cursor === undefined && input.offset !== undefined
      ? await query.offset(Math.max(input.offset, 0))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit);
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(filter))[0]?.count ?? 0;
    const events = pageRows.map((row) => ({
      id: row.id,
      kind: row.kind as AuditKind,
      action: row.action,
      actorId: row.actorId,
      actorName: row.actorName ?? null,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      details: (row.details ?? {}) as Record<string, unknown>,
      at: row.at instanceof Date ? row.at : new Date(row.at),
    }));
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const hasNext = isBackward ? events.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (input.cursor !== undefined || (input.offset ?? 0) > 0) && events.length > 0;
    return {
      events,
      total,
      nextCursor: hasNext && lastEvent
        ? encodeListCursor({ kind: 'audit', sortAt: lastEvent.at, id: lastEvent.id, total })
        : null,
      previousCursor: hasPrevious && firstEvent
        ? encodeListCursor({ kind: 'audit', sortAt: firstEvent.at, id: firstEvent.id, total })
        : null,
    };
  },
  async recordDeadLetter(
    input: { kind: AuditKind; payload: unknown; error: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(auditDeadLetter).values({
      kind: input.kind,
      payload: input.payload,
      error: input.error,
    });
  },
};

import type { TransactionRunner, TransactionContext, DocumentRepository, ChunkRepository, ChunkStore, VectorSearch, LexicalSearch, AuditLog, TicketRepository, UserRepository } from '@app/domain';

export function createDocumentRepo(client: Client): DocumentRepository {
  return {
    findByName: (name, opts) => findDocumentByName(name, client, opts),
    findByNameForUpdate: (name, opts) => findDocumentByNameForUpdate(name, client, opts),
    findById: (id, opts) => findDocumentById(id, client, opts),
    setStorageKey: (id, key) => setDocumentStorageKey(id, key, client),
    updateIngestStatus: (id, status) => updateDocumentIngestStatus(id, status, client),
    updateIngestStatusIfCurrent: (id, expectedFileHash, expectedStatus, nextStatus) =>
      updateDocumentIngestStatusIfCurrent(id, expectedFileHash, expectedStatus, nextStatus, client),
    claimIngest: (id, expectedFileHash) => claimDocumentIngest(id, client, expectedFileHash),
    restoreAfterQueueFailure: (id, expected, previous) =>
      restoreDocumentAfterQueueFailure(id, expected, previous, client),
    insert: (input, opts) => insertDocument(input, client, opts),
    update: (id, patch) => updateDocument(id, patch, client),
    updateIfCurrent: (id, expectedFileHash, patch) => updateDocumentIfCurrent(id, expectedFileHash, patch, client),
    deleteById: (id) => deleteDocumentById(id, client),
    softDelete: (id, at) => softDeleteDocument(id, at, client),
    restore: (id) => restoreDocument(id, client),
    list: (opts) => listDocuments(opts, client),
    countChunksForDocuments: (ids) => countChunksForDocuments(ids, client),
    countChunksForAll: () => countChunksForAll(client),
    countPendingIngest: () => countPendingIngestDocuments(client),
    listStaleQueued: (olderThan) => listStaleQueuedDocuments(olderThan, client),
    failDocumentIfStale: (id, olderThan) => failDocumentIfStale(id, olderThan, client),
    failDocument: (id) => failDocumentById(id, client),
    failDocumentIfCurrent: (id, expectedFileHash) => failDocumentIfCurrent(id, expectedFileHash, client),
  };
}

async function countPendingIngestDocuments(client: Client): Promise<number> {
  const [row] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(or(eq(documents.ingestStatus, 'queued'), eq(documents.ingestStatus, 'ingesting')));
  return row?.count ?? 0;
}

export function createChunkRepositoryCompat(
  store: ChunkStore,
  vector: VectorSearch,
  lexical: LexicalSearch,
): ChunkRepository {
  return {
    searchByVector: (embedding, opts) => vector.searchByVector(embedding, opts),
    searchByLexical: (query, opts) => lexical.searchByLexical(query, opts),
    getByIds: (ids) => store.getByIds(ids),
    getByDocAndRange: (documentId, start, end) => store.getByDocAndRange(documentId, start, end),
    getByDocAndRanges: (ranges) => store.getByDocAndRanges(ranges),
    insertMany: (rows) => store.insertMany(rows),
    replaceMany: async (documentId, rows) => {
      if (store.replaceMany) {
        await store.replaceMany(documentId, rows);
        return;
      }
      await store.deleteByDocumentId(documentId);
      await store.insertMany(rows);
    },
    deleteByDocumentId: (documentId) => store.deleteByDocumentId(documentId),
    countForDocuments: (ids) => store.countForDocuments(ids),
    countForAll: () => store.countForAll(),
    countForDocument: (id) => store.countForDocument(id),
    recountAll: () => store.recountAll(),
  };
}

export function createChunkRepo(
  client: Client,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): ChunkRepository {
  return createChunkRepositoryCompat(
    createChunkStore(client, vectorDim, hasher),
    createVectorSearch(client, vectorDim),
    createLexicalSearch(client),
  );
}

export function createAuditRepo(client: Client = db): AuditLog {
  return {
    logEvent: (input) => auditRepo.logEvent(input, client),
    logDocumentEvent: (input) => auditRepo.logDocumentEvent(input, client),
    logTicketEvent: (input) => auditRepo.logTicketEvent(input, client),
    logUserEvent: (input) => auditRepo.logUserEvent(input, client),
    list: (input) => auditRepo.list(input, client),
    recordDeadLetter: (input) =>
      auditRepo.recordDeadLetter(
        { kind: input.kind as AuditKind, payload: input.payload, error: input.error },
        client,
      ),
  };
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

export function createUserRepo(client: Client = db): UserRepository {
  return {
    upsertFromClerk: (input) => userRepo.upsertFromClerk(input, client),
    findByClerkId: (clerkUserId) => userRepo.findByClerkId(clerkUserId, client),
    findByIds: (clerkUserIds) => userRepo.findByIds(clerkUserIds, client),
    setRole: (clerkUserId, role) => userRepo.setRole(clerkUserId, role, client),
    touchLastSeen: (clerkUserId) => userRepo.touchLastSeen(clerkUserId, client),
    list: (opts) => userRepo.list(opts, client),
    countAll: () => userRepo.countAll(client),
    countAdmins: () => userRepo.countAdmins(client),
    countAdminsForUpdate: () => userRepo.countAdminsForUpdate(client),
  };
}

export function createRepositoryAdapters(
  client: Client = db,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
) {
  return {
    documents: createDocumentRepo(client),
    chunks: createChunkRepo(client, vectorDim, hasher),
    audit: createAuditRepo(client),
    tickets: createTicketRepo(client),
    users: createUserRepo(client),
  };
}

export const transactionRunner: TransactionRunner = {
  async run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const ctx: TransactionContext = createRepositoryAdapters(tx, resolveVectorDim());
      return fn(ctx);
    });
  },
};
