import { eq, desc, ilike, or, sql, inArray, isNull, and } from 'drizzle-orm';
import { db } from './client';
import { VECTOR_DIM } from './schema-vector';
import {
  documents,
  chunks,
  tickets,
  users,
  documentAudit,
  ticketAudit,
  userAudit,
  type Document,
} from './schema';
import type { TicketRow, UserRow } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function whereAnd(parts: ReturnType<typeof eq>[]) {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

export async function findDocumentByName(
  name: string,
  client: Client = db,
  opts: { includeDeleted?: boolean } = {},
): Promise<Document | null> {
  const parts = [eq(documents.fileName, name)];
  if (!opts.includeDeleted) parts.push(isNull(documents.deletedAt));
  const row = await client.query.documents.findFirst({ where: whereAnd(parts) });
  return (row as Document | undefined) ?? null;
}

export async function findDocumentById(
  id: number,
  client: Client = db,
  opts: { includeDeleted?: boolean } = {},
): Promise<Document | null> {
  const parts = [eq(documents.id, id)];
  if (!opts.includeDeleted) parts.push(isNull(documents.deletedAt));
  const row = await client.query.documents.findFirst({ where: whereAnd(parts) });
  return (row as Document | undefined) ?? null;
}

export async function insertDocument(
  input: { fileName: string; fileHash: string; uploadedBy: string },
  client: Client = db,
): Promise<Document> {
  const [row] = await client
    .insert(documents)
    .values(input)
    .onConflictDoUpdate({
      target: documents.fileName,
      set: { fileHash: input.fileHash, uploadedBy: input.uploadedBy },
    })
    .returning();
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

export async function searchChunksByVector(
  embedding: number[],
  opts: { threshold: number; limit: number; filter?: { documentId?: number } },
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((v) => Number.isFinite(v))) {
    throw new Error('Invalid embedding: must be a non-empty array of finite numbers');
  }
  if (embedding.length !== VECTOR_DIM) {
    throw new Error(`Invalid embedding: expected ${VECTOR_DIM} dimensions, got ${embedding.length}`);
  }
  const vectorLiteral = `[${embedding.join(',')}]`;
  const result = await client.execute(sql`
    WITH matches AS (
      SELECT
        c.id AS id,
        c.document_id AS "documentId",
        d.file_name AS "fileName",
        c.page AS page,
        c.section_title AS "sectionTitle",
        c.source AS source,
        c.content AS content,
        c.parent_chunk_id AS "parentChunkId",
        c.chunk_index AS "chunkIndex",
        1 - (c.embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.deleted_at IS NULL
        AND c.kind <> 'parent'
      ${opts.filter?.documentId != null ? sql`AND c.document_id = ${opts.filter.documentId}` : sql``}
    )
    SELECT id, "documentId", "fileName", page, "sectionTitle", source, content, "parentChunkId", "chunkIndex", similarity
    FROM matches
    WHERE similarity > ${opts.threshold}
    ORDER BY similarity DESC
    LIMIT ${opts.limit}
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

export async function searchChunksByLexical(
  query: string,
  opts: { limit: number; filter?: { documentId?: number } },
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  if (!query.trim()) return [];
  const lexQuery = sql`plainto_tsquery('english', ${query})`;
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      ts_rank(c.tsv, ${lexQuery}) AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND c.kind <> 'parent'
      AND c.tsv @@ ${lexQuery}
      ${opts.filter?.documentId != null ? sql`AND c.document_id = ${opts.filter.documentId}` : sql``}
    ORDER BY similarity DESC
    LIMIT ${opts.limit}
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

/** Map a prepared chunk row to its `chunks` insert values. */
function toChunkValues(r: {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex?: number;
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
  parentChunkId?: number | null;
  kind?: 'parent' | 'child' | 'summary';
  embeddingModel?: string | null;
  contentHash?: string | null;
}) {
  return {
    documentId: r.documentId,
    content: r.content,
    embedding: r.embedding,
    chunkIndex: r.chunkIndex ?? 0,
    page: r.page ?? null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    parentChunkId: r.parentChunkId ?? null,
    kind: r.kind ?? 'child',
    embeddingModel: r.embeddingModel ?? null,
    contentHash: r.contentHash ?? null,
  };
}

export async function insertChunks(
  rows: Array<{
    documentId: number;
    content: string;
    embedding: number[];
    chunkIndex?: number;
    page?: number | null;
    sectionTitle?: string | null;
    source?: string | null;
    parentChunkId?: number | null;
    kind?: 'parent' | 'child' | 'summary';
    embeddingModel?: string | null;
    contentHash?: string | null;
  }>,
  client: Client = db,
): Promise<void> {
  if (rows.length === 0) return;
  for (const r of rows) {
    if (r.embedding.length !== VECTOR_DIM) {
      throw new Error(`Invalid embedding: expected ${VECTOR_DIM} dimensions, got ${r.embedding.length}`);
    }
  }
  const BATCH_SIZE = 500;

  // Two-pass insert for parent-child indices (Session 5). Children reference
  // their parent via a *transient* key equal to the parent's global
  // `chunkIndex`; parents have `parentChunkId = null`. We insert parents
  // first, capture their real surrogate ids, then rewrite each child's
  // `parentChunkId` before inserting the children (so the self-FK holds).
  const parents = rows.filter((r) => r.kind === 'parent');
  if (parents.length === 0) {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await client.insert(chunks).values(rows.slice(i, i + BATCH_SIZE).map(toChunkValues));
    }
    return;
  }

  const parentIndices = parents.map((r) => r.chunkIndex ?? 0);
  const uniqueIndices = new Set(parentIndices);
  if (uniqueIndices.size !== parentIndices.length) {
    throw new Error(
      'insertChunks: parent chunkIndex values must be unique within a batch for self-FK resolution',
    );
  }

  const indexToId = new Map<number, number>();
  for (let i = 0; i < parents.length; i += BATCH_SIZE) {
    const batch = parents.slice(i, i + BATCH_SIZE);
    const inserted = await client
      .insert(chunks)
      .values(batch.map(toChunkValues))
      .returning({ id: chunks.id, chunkIndex: chunks.chunkIndex });
    for (const row of inserted) {
      indexToId.set(Number(row.chunkIndex), Number(row.id));
    }
  }

  const children = rows.filter((r) => r.kind !== 'parent');
  for (let i = 0; i < children.length; i += BATCH_SIZE) {
    const batch = children.slice(i, i + BATCH_SIZE);
    await client.insert(chunks).values(
      batch.map((r) => {
        const realParentId =
          r.parentChunkId != null ? indexToId.get(r.parentChunkId) ?? null : null;
        return { ...toChunkValues(r), parentChunkId: realParentId };
      }),
    );
  }
}

/** Fetch chunks by surrogate id (used to resolve child hits to parent blocks). */
export async function getChunksByIds(
  ids: number[],
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  if (ids.length === 0) return [];
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      0 AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND ${inArray(chunks.id, ids)}
    ORDER BY c.id
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

/** Fetch chunks of a document whose `chunkIndex` lies in `[start, end]`. */
export async function getChunksByDocAndRange(
  documentId: number,
  start: number,
  end: number,
  client: Client = db,
): Promise<
  Array<{
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    similarity: number;
    parentChunkId: number | null;
    chunkIndex: number;
  }>
> {
  const result = await client.execute(sql`
    SELECT
      c.id AS id,
      c.document_id AS "documentId",
      d.file_name AS "fileName",
      c.page AS page,
      c.section_title AS "sectionTitle",
      c.source AS source,
      c.content AS content,
      c.parent_chunk_id AS "parentChunkId",
      c.chunk_index AS "chunkIndex",
      0 AS similarity
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE d.deleted_at IS NULL
      AND c.document_id = ${documentId}
      AND c.chunk_index >= ${start}
      AND c.chunk_index <= ${end}
    ORDER BY c.chunk_index
  `);
  type RawRow = {
    id: number;
    documentId: number;
    fileName: string | null;
    page: number | null;
    sectionTitle: string | null;
    source: string | null;
    content: string;
    parentChunkId: number | null;
    chunkIndex: number;
    similarity: number;
  };
  const rows = (result as unknown as { rows?: RawRow[] }).rows ?? [];
  return rows.map((r) => ({
    id: Number(r.id),
    documentId: Number(r.documentId),
    fileName: r.fileName ?? null,
    page: r.page != null ? Number(r.page) : null,
    sectionTitle: r.sectionTitle ?? null,
    source: r.source ?? null,
    content: r.content,
    parentChunkId: r.parentChunkId != null ? Number(r.parentChunkId) : null,
    chunkIndex: Number(r.chunkIndex),
    similarity: Number(r.similarity),
  }));
}

export async function deleteChunksByDocumentId(documentId: number, client: Client = db): Promise<void> {
  await client.delete(chunks).where(eq(chunks.documentId, documentId));
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
    status?: 'created' | 'in_progress' | 'closed';
    assignee?: string | null;
    search?: string;
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
};

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
    const { clerkClient } = await import('../auth');
    const client = await clerkClient();
    await client.users.updateUserMetadata(clerkUserId, {
      publicMetadata: { role },
    });
  },
};

export const auditRepo = {
  async logDocumentEvent(
    input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(documentAudit).values(input);
  },
  async logTicketEvent(
    input: { action: 'create' | 'assign' | 'status_change' | 'note' | 'impersonation' | 'role_change'; ticketId: string; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(ticketAudit).values(input);
  },
  async logUserEvent(
    input: { targetUserId: string; actorId: string; fromRole: 'admin' | 'user'; toRole: 'admin' | 'user' },
    client: Client = db,
  ): Promise<void> {
    await client.insert(userAudit).values(input);
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

import type { TransactionRunner, TransactionContext, DocumentRepository, ChunkRepository, AuditLog, TicketRepository, UserRepository } from '@app/domain';

export function createDocumentRepo(client: Client): DocumentRepository {
  return {
    findByName: (name, opts) => findDocumentByName(name, client, opts),
    findById: (id, opts) => findDocumentById(id, client, opts),
    setStorageKey: (id, key) => setDocumentStorageKey(id, key, client),
    updateIngestStatus: (id, status) => updateDocumentIngestStatus(id, status, client),
    claimIngest: (id) => claimDocumentIngest(id, client),
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
    searchByLexical: (query, opts) => searchChunksByLexical(query, opts, client),
    getByIds: (ids) => getChunksByIds(ids, client),
    getByDocAndRange: (documentId, start, end) => getChunksByDocAndRange(documentId, start, end, client),
    insertMany: (rows) => insertChunks(rows, client),
    deleteByDocumentId: (documentId) => deleteChunksByDocumentId(documentId, client),
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
    logUserEvent: (input) => auditRepo.logUserEvent(input, client),
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
