// Drizzle-backed repository implementations.
import { eq, desc, ilike, or, sql, inArray, isNull, and } from 'drizzle-orm';
import { db } from './client';
import {
  documents,
  chunks,
  tickets,
  users,
  documentAudit,
  ticketAudit,
  type Document,
} from './schema';
import type { TicketRow, UserRow } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function whereAnd(parts: ReturnType<typeof eq>[]) {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

// ---- Documents / Chunks ----

export async function findDocumentByName(name: string, client: Client = db): Promise<Document | null> {
  const row = await client.query.documents.findFirst({ where: eq(documents.fileName, name) });
  return (row as Document | undefined) ?? null;
}

export async function findDocumentById(id: number, client: Client = db): Promise<Document | null> {
  const row = await client.query.documents.findFirst({ where: eq(documents.id, id) });
  return (row as Document | undefined) ?? null;
}

export async function insertDocument(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client = db,
): Promise<Document> {
  const [row] = await client.insert(documents).values(input).returning();
  if (!row) throw new Error('Failed to insert document');
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

export async function softDeleteDocument(id: number, at: Date, client: Client = db): Promise<Document | null> {
  const [row] = await client.update(documents).set({ deletedAt: at }).where(eq(documents.id, id)).returning();
  return (row as Document | null) ?? null;
}

export async function restoreDocument(id: number, client: Client = db): Promise<Document | null> {
  const [row] = await client.update(documents).set({ deletedAt: null }).where(eq(documents.id, id)).returning();
  return (row as Document | null) ?? null;
}

export async function searchChunksByVector(
  embedding: number[],
  opts: { threshold: number; limit: number },
  client: Client = db,
): Promise<Array<{ content: string; similarity: number }>> {
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((v) => Number.isFinite(v))) {
    throw new Error('Invalid embedding: must be a non-empty array of finite numbers');
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  const result = await client.execute(sql`
    SELECT content, 1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM chunks
    WHERE 1 - (embedding <=> ${vectorLiteral}::vector) > ${opts.threshold}
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${opts.limit}
  `);
  const rows = (result as unknown as { rows?: Array<{ content: string; similarity: number }> })
    .rows ?? [];
  return rows.map((r) => ({ content: r.content, similarity: Number(r.similarity) }));
}

export async function insertChunks(
  rows: Array<{ documentId: number; content: string; embedding: number[] }>,
  client: Client = db,
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await client.insert(chunks).values(rows.slice(i, i + BATCH_SIZE));
  }
}

export async function countChunksForDocuments(
  documentIds: number[],
  client: Client = db,
): Promise<Map<number, number>> {
  if (documentIds.length === 0) return new Map();
  const rows = await client
    .select({ documentId: chunks.documentId, count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(inArray(chunks.documentId, documentIds))
    .groupBy(chunks.documentId);
  return new Map(rows.map((r) => [r.documentId, r.count]));
}

export async function countChunksForAll(client: Client = db): Promise<number> {
  const [row] = await client.select({ count: sql<number>`count(*)::int` }).from(chunks);
  return row?.count ?? 0;
}

export async function countChunksForDocument(id: number, client: Client = db): Promise<number> {
  const [row] = await client
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.documentId, id));
  return row?.count ?? 0;
}

export async function recountChunksForAll(client: Client = db): Promise<Array<{ documentId: number; count: number }>> {
  const rows = await client
    .select({ documentId: chunks.documentId, count: sql<number>`count(*)::int` })
    .from(chunks)
    .groupBy(chunks.documentId);
  return rows;
}

export async function listDocuments(
  opts: {
    search?: string;
    includeDeleted?: boolean;
    limit: number;
    offset: number;
  },
  client: Client = db,
): Promise<{ documents: Array<Document & { hasBlob: boolean }>; total: number }> {
  const whereParts = [] as ReturnType<typeof eq>[];
  if (!opts.includeDeleted) whereParts.push(isNull(documents.deletedAt));
  if (opts.search) whereParts.push(ilike(documents.fileName, `%${opts.search.replace(/[%_]/g, '\\$&')}%`));
  const where = whereAnd(whereParts);
  const rows = await client
    .select({
      id: documents.id,
      fileName: documents.fileName,
      fileHash: documents.fileHash,
      uploadedBy: documents.uploadedBy,
      uploadedAt: documents.uploadedAt,
      storageKey: documents.storageKey,
      ingestStatus: documents.ingestStatus,
      hasBlob: sql<boolean>`${documents.storageKey} IS NOT NULL`.as('hasBlob'),
      deletedAt: documents.deletedAt,
      total: sql<number>`count(*) over()`.as('total'),
    })
    .from(documents)
    .where(where)
    .orderBy(desc(documents.uploadedAt))
    .limit(opts.limit)
    .offset(opts.offset);
  const total = rows[0]?.total ?? 0;
  return { documents: rows as unknown as Array<Document & { hasBlob: boolean }>, total };
}

// ---- Tickets ----

export const ticketRepo = {
  async findByTicketId(ticketId: string, client: Client = db): Promise<TicketRow | null> {
    const row = await client.query.tickets.findFirst({ where: eq(tickets.ticketId, ticketId) });
    return (row as TicketRow | undefined) ?? null;
  },
  async list(opts: {
    status?: 'created' | 'in_progress' | 'closed';
    assignee?: string | null;
    search?: string;
    limit: number;
    offset: number;
  }, client: Client = db): Promise<{ rows: TicketRow[]; total: number }> {
    // Defense-in-depth: enforce a hard maximum at the repository level.
    const limit = Math.min(Math.max(opts.limit, 1), 500);
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
        total: sql<number>`count(*) over()`.as('total'),
      })
      .from(tickets)
      .where(where)
      .orderBy(desc(tickets.createdAt))
      .limit(limit)
      .offset(opts.offset);
    const total = rows[0]?.total ?? 0;
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
};

// ---- Users ----

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
          name: input.name ?? null,
          imageUrl: input.imageUrl ?? null,
          role: input.role,
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
  async list(opts: { search?: string; limit: number; offset: number }, client: Client = db): Promise<{ rows: UserRow[]; total: number }> {
    const search = opts.search?.trim();
    const where = search
      ? or(
          ilike(users.email, `%${search.replace(/[%_]/g, '\\$&')}%`),
          ilike(users.name, `%${search.replace(/[%_]/g, '\\$&')}%`),
        )
      : undefined;
    const rows = (await client
      .select()
      .from(users)
      .where(where)
      .orderBy(users.createdAt)
      .limit(opts.limit)
      .offset(opts.offset)) as UserRow[];
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
  async syncClerkRole(clerkUserId: string, role: 'admin' | 'user'): Promise<void> {
    const { clerkClient } = await import('../auth/clerk-session');
    const client = await clerkClient();
    await client.users.updateUserMetadata(clerkUserId, {
      publicMetadata: { role },
    });
  },
};

// ---- Audit ----

export const auditRepo = {
  async logDocumentEvent(
    input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(documentAudit).values(input);
  },
  async logTicketEvent(
    input: { action: 'create' | 'assign' | 'status_change' | 'note' | 'role_change'; ticketId: string; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(ticketAudit).values(input);
  },
  async list(input: { documentId?: number; ticketId?: string; limit: number; offset: number }, client: Client = db): Promise<{
    events: Array<{
      id: number; kind: 'document' | 'ticket';
      documentId: number | null; ticketId: string | null;
      actorId: string; actorName: string | null;
      action: string; at: Date;
    }>;
    total: number;
  }> {
    // When both documentId and ticketId are provided, the total is the sum of
    // document_audit rows matching documentId plus ticket_audit rows matching
    // ticketId. If only one filter is provided the other count is 0.
    const wantDoc = !input.ticketId || input.documentId !== undefined;
    const wantTix = !input.documentId || input.ticketId !== undefined;
    const docWhere = input.documentId
      ? sql`WHERE document_id = ${input.documentId}`
      : wantDoc
        ? sql``
        : sql`WHERE 1 = 0`;
    const tixWhere = input.ticketId
      ? sql`WHERE ticket_id = ${input.ticketId}`
      : wantTix
        ? sql``
        : sql`WHERE 1 = 0`;
    const countResult = await client.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM (
        SELECT id FROM document_audit ${docWhere}
        UNION ALL
        SELECT id FROM ticket_audit ${tixWhere}
      ) c
    `);
    const total = (countResult as unknown as { rows?: Array<{ count: number }> }).rows?.[0]?.count ?? 0;
    const actorResult = await client.execute<{
      id: number; kind: string; document_id: number | null; ticket_id: string | null;
      actor_id: string; action: string; at: Date; actor_name: string | null;
    }>(sql`
      SELECT c.*, u.name AS actor_name FROM (
        SELECT id, 'document' AS kind, document_id, NULL::text AS ticket_id, actor_id, action, at
        FROM document_audit ${docWhere}
        UNION ALL
        SELECT id, 'ticket' AS kind, NULL::int AS document_id, ticket_id, actor_id, action, at
        FROM ticket_audit ${tixWhere}
      ) c
      LEFT JOIN users u ON u.clerk_user_id = c.actor_id
      ORDER BY c.at DESC
      LIMIT ${input.limit}
      OFFSET ${input.offset}
    `);
    const rawRows = (actorResult as unknown as { rows?: Array<{ id: number; kind: string; document_id: number | null; ticket_id: string | null; actor_id: string; action: string; at: Date; actor_name: string | null }> }).rows ?? [];
    const events = rawRows.map((r) => ({
      id: r.id,
      kind: r.kind as 'document' | 'ticket',
      documentId: r.document_id ?? null,
      ticketId: r.ticket_id ?? null,
      actorId: r.actor_id,
      actorName: r.actor_name ?? null,
      action: r.action,
      at: r.at instanceof Date ? r.at : new Date(r.at),
    }));
    return { events, total };
  },
};

// ---- Transaction runner ----
// Wraps Drizzle's db.transaction() so the application layer
// can execute multiple repository calls atomically.

import type { TransactionRunner, TransactionContext, DocumentRepository, ChunkRepository, AuditLog, TicketRepository, UserRepository } from '@app/domain';

export function createDocumentRepo(client: Client): DocumentRepository {
  return {
    findByName: (name) => findDocumentByName(name, client),
    findById: (id) => findDocumentById(id, client),
    setStorageKey: (id, key) => setDocumentStorageKey(id, key, client),
    updateIngestStatus: (id, status) => updateDocumentIngestStatus(id, status, client),
    insert: (input) => insertDocument(input, client),
    deleteById: (id) => deleteDocumentById(id, client),
    softDelete: (id, at) => softDeleteDocument(id, at, client),
    restore: (id) => restoreDocument(id, client),
    list: (opts) => listDocuments(opts, client),
    countChunksForDocuments: (ids) => countChunksForDocuments(ids, client),
    countChunksForAll: () => countChunksForAll(client),
  };
}

export function createChunkRepo(client: Client): ChunkRepository {
  return {
    searchByVector: (embedding, opts) => searchChunksByVector(embedding, opts, client),
    insertMany: (rows) => insertChunks(rows, client),
    countForDocuments: (ids) => countChunksForDocuments(ids, client),
    countForAll: () => countChunksForAll(client),
    countForDocument: (id) => countChunksForDocument(id, client),
    recountAll: () => recountChunksForAll(client),
  };
}

function createAuditRepo(client: Client): AuditLog {
  return {
    logDocumentEvent: (input) => auditRepo.logDocumentEvent(input, client),
    logTicketEvent: (input) => auditRepo.logTicketEvent(input, client),
    list: (input) => auditRepo.list(input, client),
  };
}

function createTicketRepo(client: Client): TicketRepository {
  return {
    findByTicketId: (ticketId) => ticketRepo.findByTicketId(ticketId, client),
    list: (opts) => ticketRepo.list(opts, client),
    latest: () => ticketRepo.latest(client),
    insert: (input) => ticketRepo.insert(input, client),
    update: (ticketId, patch) => ticketRepo.update(ticketId, patch, client),
    countAll: () => ticketRepo.countAll(client),
    countOpen: () => ticketRepo.countOpen(client),
  };
}

function createUserRepo(client: Client): UserRepository {
  return {
    upsertFromClerk: (input) => userRepo.upsertFromClerk(input, client),
    findByClerkId: (clerkUserId) => userRepo.findByClerkId(clerkUserId, client),
    findByIds: (clerkUserIds) => userRepo.findByIds(clerkUserIds, client),
    setRole: (clerkUserId, role) => userRepo.setRole(clerkUserId, role, client),
    touchLastSeen: (clerkUserId) => userRepo.touchLastSeen(clerkUserId, client),
    list: (opts) => userRepo.list(opts, client),
    countAll: () => userRepo.countAll(client),
    syncClerkRole: (clerkUserId, role) => userRepo.syncClerkRole(clerkUserId, role),
  };
}

export const transactionRunner: TransactionRunner = {
  async run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const ctx: TransactionContext = {
        documents: createDocumentRepo(tx),
        chunks: createChunkRepo(tx),
        audit: createAuditRepo(tx),
        tickets: createTicketRepo(tx),
        users: createUserRepo(tx),
      };
      return fn(ctx);
    });
  },
};
