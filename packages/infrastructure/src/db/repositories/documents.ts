import { and, asc, desc, eq, gt, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import { documents, type Document } from '../schema';
import type { CursorContext, DocumentListCursor, DocumentRepository, IngestStatus, ListCursorCodec } from '@app/domain';
import { MAX_LEGACY_LIST_OFFSET, ValidationError } from '@app/domain';
import { countChunksForAll, countChunksForDocuments } from '../chunk-store';
import type { Client } from './shared';
import { encodeRepositoryCursor, escapeLikePattern, requiredAnd, requiredOr, whereAnd } from './shared';

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
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
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
    ? await query.offset(Math.min(Math.max(opts.offset, 0), MAX_LEGACY_LIST_OFFSET))
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
      ? encodeRepositoryCursor(
          { kind: 'documents', sortAt: lastRow.uploadedAt, id: lastRow.id, total },
          opts.cursorCodec,
          opts.cursorContext,
        )
      : null,
    previousCursor: hasPrevious && firstRow
      ? encodeRepositoryCursor(
          { kind: 'documents', sortAt: firstRow.uploadedAt, id: firstRow.id, total },
          opts.cursorCodec,
          opts.cursorContext,
        )
      : null,
  };
}

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
