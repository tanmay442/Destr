import { eq, desc, ilike, or, sql, isNull, and, lt } from 'drizzle-orm';
import { db } from './client';
import {
  documents,
  chunks,
  tickets,
  users,
  auditEvents,
  auditDeadLetter,
  type Document,
} from './schema';
import type { TicketRow, UserRow, IngestStatus, AuditEventInput, AuditEventRecord, AuditKind, AuditListFilter, TicketResponseTimes, ChatEventRange } from '@app/domain';
import { ValidationError, MAX_LIST_LIMIT, MAX_AUDIT_LIMIT } from '@app/domain';
import { createChunkStore, countChunksForDocuments, countChunksForAll } from './chunk-store';
import { createVectorSearch } from './vector-search';
import { createLexicalSearch } from './lexical-search';

export { searchChunksByVector } from './vector-search';
export { searchChunksByLexical } from './lexical-search';
export {
  insertChunks,
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

function whereAnd(parts: ReturnType<typeof eq>[]) {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

export async function findDocumentByName(
  name: string,
  client: Client = db,
  opts: { includeDeleted?: boolean | undefined } = {},
): Promise<Document | null> {
  const parts = [eq(documents.fileName, name)];
  if (!opts.includeDeleted) parts.push(isNull(documents.deletedAt));
  const row = await client.query.documents.findFirst({ where: whereAnd(parts) });
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

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}

export async function insertDocument(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client = db,
): Promise<Document> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await tryInsert(input, client);
    } catch (e) {
      if (!isUniqueViolation(e) || attempt === 1) throw e;
    }
  }
  throw new Error('Failed to insert document');
}

async function tryInsert(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client,
): Promise<Document> {
  const existing = await client.query.documents.findFirst({
    where: eq(documents.fileName, input.fileName),
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
  if (existing && existing.deletedAt != null) {
    const existingId = existing.id;
    const resurrect = async () => {
      await client.delete(chunks).where(eq(chunks.documentId, existingId));
      const [row] = await client
        .update(documents)
        .set({
          fileHash: input.fileHash,
          uploadedBy: input.uploadedBy,
          deletedAt: null,
          ingestStatus: 'done',
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
  const [row] = await client.update(documents).set(patch).where(eq(documents.id, id)).returning();
  if (!row) throw new Error(`Failed to update document ${id}`);
  return row as Document;
}

export async function deleteDocumentById(id: number, client: Client = db): Promise<void> {
  await client.delete(documents).where(eq(documents.id, id));
}

export async function setDocumentStorageKey(id: number, key: string, client: Client = db): Promise<void> {
  await client.update(documents).set({ storageKey: key }).where(eq(documents.id, id));
}

export async function updateDocumentIngestStatus(
  id: number,
  status: 'queued' | 'ingesting' | 'done' | 'failed',
  client: Client = db,
): Promise<void> {
  await client.update(documents).set({ ingestStatus: status }).where(eq(documents.id, id));
}

export async function listStaleQueuedDocuments(olderThan: Date, client: Client = db): Promise<number[]> {
  const rows = await client
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.ingestStatus, 'queued'), isNull(documents.deletedAt), lt(documents.uploadedAt, olderThan)));
  return rows.map((r) => r.id);
}

export async function failDocumentById(id: number, client: Client = db): Promise<void> {
  await client.update(documents).set({ ingestStatus: 'failed' }).where(and(eq(documents.id, id), eq(documents.ingestStatus, 'queued')));
}

/** Conditional claim: flips `queued`→`ingesting` atomically; true iff a row was updated. */
export async function claimDocumentIngest(id: number, client: Client = db): Promise<boolean> {
  const [row] = await client
    .update(documents)
    .set({ ingestStatus: 'ingesting' })
    .where(and(eq(documents.id, id), eq(documents.ingestStatus, 'queued')))
    .returning({ id: documents.id });
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
    offset: number;
  },
  client: Client = db,
): Promise<{ documents: Array<Document & { hasBlob: boolean }>; total: number }> {
  const whereParts = [] as ReturnType<typeof eq>[];
  if (!opts.includeDeleted) whereParts.push(isNull(documents.deletedAt));
  if (opts.search) whereParts.push(ilike(documents.fileName, `%${opts.search.replace(/[%_]/g, '\\$&')}%`));
  const where = whereAnd(whereParts);
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const offset = Math.max(opts.offset, 0);
  const rows = await client
    .select({
      id: documents.id,
      fileName: documents.fileName,
      fileHash: documents.fileHash,
      uploadedBy: documents.uploadedBy,
      uploadedAt: documents.uploadedAt,
      storageKey: documents.storageKey,
      ingestStatus: documents.ingestStatus,
      hasBlob: sql<boolean>`(${documents.storageKey} IS NOT NULL OR ${documents.blob} IS NOT NULL)`.as('hasBlob'),
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(where)
    .orderBy(desc(documents.uploadedAt), desc(documents.id))
    .limit(limit)
    .offset(offset);
  const total = (await client
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(where))[0]?.count ?? 0;
  return { documents: rows as unknown as Array<Document & { hasBlob: boolean }>, total };
}

export const ticketRepo = {
  async findByTicketId(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const row = await client.query.tickets.findFirst({ where: eq(tickets.ticketId, ticketId) });
    return (row as TicketRow | undefined) ?? null;
  },
  async list(opts: {
    status?: 'created' | 'in_progress' | 'closed' | undefined;
    assignee?: string | null | undefined;
    search?: string | undefined;
    limit: number;
    offset: number;
  }, client: Client = db): Promise<{ rows: TicketRow[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit, 1), 500);
    const offset = Math.max(opts.offset, 0);
    const whereParts = [] as ReturnType<typeof eq>[];
    if (opts.status) whereParts.push(eq(tickets.status, opts.status));
    if (opts.assignee !== undefined && opts.assignee !== null) {
      whereParts.push(eq(tickets.assignedTo, opts.assignee));
    }
    if (opts.search) whereParts.push(ilike(tickets.issue, `%${opts.search.replace(/[%_]/g, '\\$&')}%`));
    const where = whereAnd(whereParts);
    const rows = await client
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
      .where(where)
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(limit)
      .offset(offset);
    const total = (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(tickets)
      .where(where))[0]?.count ?? 0;
    return { rows: rows as unknown as TicketRow[], total };
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

export const userRepo = {
  async upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
  }, client: Client = db): Promise<UserRow> {
    const [row] = await client
      .insert(users)
      .values(input)
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
    return (row as UserRow | null) ?? null;
  },
  async touchLastSeen(clerkUserId: string, client: Client = db): Promise<void> {
    await client.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.clerkUserId, clerkUserId));
  },
  async list(opts: { search?: string | undefined; limit: number; offset: number }, client: Client = db): Promise<{ rows: UserRow[]; total: number }> {
    const search = opts.search?.trim();
    const where = search
      ? or(
          ilike(users.email, `%${search.replace(/[%_]/g, '\\$&')}%`),
          ilike(users.name, `%${search.replace(/[%_]/g, '\\$&')}%`),
        )
      : undefined;
    const limit = Math.min(Math.max(opts.limit, 1), MAX_LIST_LIMIT);
    const offset = Math.max(opts.offset, 0);
    const rows = (await client
      .select()
      .from(users)
      .where(where)
      .orderBy(users.createdAt)
      .limit(limit)
      .offset(offset)) as UserRow[];
    const [totalRow] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(where);
    return { rows, total: totalRow?.count ?? 0 };
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
  async list(input: AuditListFilter, client: Client = db): Promise<{ events: AuditEventRecord[]; total: number }> {
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
    const parts = [] as ReturnType<typeof eq>[];
    if (input.kind) parts.push(eq(auditEvents.kind, input.kind));
    if (input.action) parts.push(eq(auditEvents.action, input.action));
    if (input.actorId) parts.push(eq(auditEvents.actorId, input.actorId));
    if (input.from) parts.push(sql`${auditEvents.at} >= ${input.from}` as unknown as ReturnType<typeof eq>);
    if (input.to) parts.push(sql`${auditEvents.at} <= ${input.to}` as unknown as ReturnType<typeof eq>);
    if (input.documentId !== undefined) {
      parts.push(eq(auditEvents.kind, 'document'), eq(auditEvents.targetId, String(input.documentId)));
    }
    if (input.ticketId !== undefined) {
      parts.push(eq(auditEvents.kind, 'ticket'), eq(auditEvents.targetId, input.ticketId));
    }
    const where = whereAnd(parts);
    const limit = Math.min(Math.max(input.limit, 1), MAX_AUDIT_LIMIT);
    const offset = Math.max(input.offset, 0);
    const rows = await client
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
      .where(where)
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit)
      .offset(offset);
    const total = (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(where))[0]?.count ?? 0;
    const events = rows.map((r) => ({
      id: r.id,
      kind: r.kind as AuditKind,
      action: r.action,
      actorId: r.actorId,
      actorName: r.actorName ?? null,
      targetType: r.targetType ?? null,
      targetId: r.targetId ?? null,
      details: (r.details ?? {}) as Record<string, unknown>,
      at: r.at instanceof Date ? r.at : new Date(r.at),
    }));
    return { events, total };
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
    findById: (id, opts) => findDocumentById(id, client, opts),
    setStorageKey: (id, key) => setDocumentStorageKey(id, key, client),
    updateIngestStatus: (id, status) => updateDocumentIngestStatus(id, status, client),
    claimIngest: (id) => claimDocumentIngest(id, client),
    insert: (input) => insertDocument(input, client),
    update: (id, patch) => updateDocument(id, patch, client),
    deleteById: (id) => deleteDocumentById(id, client),
    softDelete: (id, at) => softDeleteDocument(id, at, client),
    restore: (id) => restoreDocument(id, client),
    list: (opts) => listDocuments(opts, client),
    countChunksForDocuments: (ids) => countChunksForDocuments(ids, client),
    countChunksForAll: () => countChunksForAll(client),
    countPendingIngest: () => countPendingIngestDocuments(client),
    listStaleQueued: (olderThan) => listStaleQueuedDocuments(olderThan, client),
    failDocument: (id) => failDocumentById(id, client),
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
    deleteByDocumentId: (documentId) => store.deleteByDocumentId(documentId),
    countForDocuments: (ids) => store.countForDocuments(ids),
    countForAll: () => store.countForAll(),
    countForDocument: (id) => store.countForDocument(id),
    recountAll: () => store.recountAll(),
  };
}

export function createChunkRepo(client: Client): ChunkRepository {
  return createChunkRepositoryCompat(
    createChunkStore(client),
    createVectorSearch(client),
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
    recordDeadLetter: (input) => auditRepo.recordDeadLetter(input, client),
  };
}

export function createTicketRepo(client: Client = db): TicketRepository {
  return {
    findByTicketId: (ticketId) => ticketRepo.findByTicketId(ticketId, client),
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

export function createRepositoryAdapters(client: Client = db) {
  return {
    documents: createDocumentRepo(client),
    chunks: createChunkRepo(client),
    audit: createAuditRepo(client),
    tickets: createTicketRepo(client),
    users: createUserRepo(client),
  };
}

export const transactionRunner: TransactionRunner = {
  async run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const ctx: TransactionContext = createRepositoryAdapters(tx);
      return fn(ctx);
    });
  },
};
