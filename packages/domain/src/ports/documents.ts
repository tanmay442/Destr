import type { CursorContext, ListCursorCodec } from '../pagination';
import type { DocumentListCursor } from './cursors';
import type { CursorPageInfo } from './cursors';

/** Ingest lifecycle: `queued`→`ingesting`→`done`; `failed` is terminal despite QStash retry budget. */

export type IngestStatus = 'queued' | 'ingesting' | 'done' | 'failed';

export interface DocumentRow {
  id: number;
  /** Stable identity retained when the numeric compatibility id stays the same. */
  documentUid?: string;
  fileName: string;
  fileHash: string;
  uploadedBy: string;
  uploadedAt: Date;
  storageKey: string | null;
  ingestStatus: IngestStatus;
  ingestUpdatedAt?: Date | null;
  deletedAt: Date | null;
}

export interface DocumentRepository {
  findByName(fileName: string, opts?: { includeDeleted?: boolean | undefined }): Promise<DocumentRow | null>;
  findByNameForUpdate?(fileName: string, opts?: { includeDeleted?: boolean | undefined }): Promise<DocumentRow | null>;
  findById(id: number, opts?: { includeDeleted?: boolean | undefined }): Promise<DocumentRow | null>;
  setStorageKey(id: number, key: string | null): Promise<void>;
  updateIngestStatus(id: number, status: IngestStatus): Promise<void>;
  /** Atomically flip `queued`→`ingesting`; returns true iff this caller won the claim. */
  claimIngest(id: number, expectedFileHash?: string): Promise<boolean>;
  /** Change an ingest status only while the row still has the expected hash and status. */
  updateIngestStatusIfCurrent?(
    id: number,
    expectedFileHash: string,
    expectedStatus: IngestStatus,
    nextStatus: IngestStatus,
  ): Promise<boolean>;
  /** Mark an ingest failed only when its hash and current status still match. */
  failDocumentIfCurrent?(id: number, expectedFileHash: string): Promise<boolean>;
  /** Restore or remove a queued upload only when its hash and blob key still match. */
  restoreAfterQueueFailure?(
    id: number,
    expected: { fileHash: string; storageKey: string },
    previous: { fileHash: string | null; ingestStatus: IngestStatus | null; storageKey: string | null },
  ): Promise<boolean>;
  insert(
    input: { fileName: string; fileHash: string; uploadedBy: string },
    opts?: { resurrectDeleted?: boolean | undefined },
  ): Promise<DocumentRow>;
  /** Update mutable metadata of an existing row in place (keeps its id). */
  update(
    id: number,
    patch: {
      fileName?: string;
      fileHash?: string;
      uploadedBy?: string;
      ingestStatus?: IngestStatus;
      storageKey?: string | null;
    },
  ): Promise<DocumentRow>;
  /** Update only when the document still has the expected version hash. */
  updateIfCurrent?(
    id: number,
    expectedFileHash: string,
    patch: {
      fileName?: string;
      fileHash?: string;
      uploadedBy?: string;
      ingestStatus?: IngestStatus;
      storageKey?: string | null;
    },
  ): Promise<DocumentRow | null>;
  deleteById(id: number): Promise<void>;
  softDelete(id: number, at: Date): Promise<DocumentRow | null>;
  restore(id: number): Promise<DocumentRow | null>;
  list(opts: {
    search?: string | undefined;
    includeDeleted?: boolean | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: DocumentListCursor | undefined;
    before?: DocumentListCursor | undefined;
    /** Signed cursor adapter and its normalized request binding. */
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
  }): Promise<{ documents: (DocumentRow & { hasBlob: boolean })[]; total: number } & CursorPageInfo>;
  countChunksForDocuments(documentIds: number[]): Promise<Map<number, number>>;
  countChunksForAll(): Promise<number>;
  countPendingIngest(): Promise<number>;
  listStaleQueued(olderThan: Date): Promise<number[]>;
  /** Mark a queued/ingesting document failed only if it is still stale. */
  failDocumentIfStale?(id: number, olderThan: Date): Promise<boolean>;
  failDocument(id: number): Promise<void>;
}

/** A single pre-split chunk parsed from user-supplied Markdown. */
export interface ParsedChunk {
  content: string;
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
}

/** Parses pre-chunked Markdown (delimiter-separated, optional YAML-ish meta). */
export interface MarkdownParser {
  parseChunkedMarkdown(text: string, delimiter?: string): ParsedChunk[];
}

/** A chunk produced by a chunking strategy, before embedding. */
export interface DocumentChunk {
  content: string;
  chunkIndex: number;
  page?: number | null | undefined;
  sectionTitle?: string | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  summary?: string | null | undefined;
  /** Contextual-Chunk-Header text embedded alongside `content`; excluded from stored content. */
  embeddingPrefix?: string | undefined;
  parentChunkId?: number | null | undefined;
  sourceChunkId?: number | null | undefined;
  /** Kind of chunk: `parent` (large context block), `child` (embedded for retrieval), `summary` (LLM-generated). */
  kind?: 'parent' | 'child' | 'summary' | undefined;
  embeddingModel?: string | null | undefined;
  contentHash?: string | null | undefined;
}

/** Shape returned by vector/lookup queries: provenance + similarity. */
export interface RetrievedChunkRow {
  id: number;
  documentId: number;
  /** Stable identity used by citations and re-ingest upserts. */
  documentUid?: string;
  chunkUid?: string;
  fileName: string | null;
  page: number | null;
  sectionTitle: string | null;
  source: string | null;
  title: string | null;
  content: string;
  similarity: number;
  parentChunkId: number | null;
  chunkIndex: number;
}

/** Parses raw content (e.g. PDF bytes) into structured pages. Runtime-neutral byte input. */
export interface ContentParser {
  extractPages(buffer: Uint8Array): Promise<Array<{ page: number; text: string }>>;
  extractText(buffer: Uint8Array): Promise<string>;
}

/** Performs bounded structural validation before a PDF is durably stored. */
export interface PdfValidator {
  validate(buffer: Uint8Array, opts?: { signal?: AbortSignal | undefined }): Promise<void>;
}

/** A chunking strategy that turns structured pages into DocumentChunk[]. */
export interface ChunkingStrategy {
  splitPages(pages: Array<{ page: number; text: string }>): Promise<DocumentChunk[]>;
}

/** A chunk row prepared for storage (relational + vector). */
export interface InsertChunkInput {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex?: number;
  page?: number | null | undefined;
  sectionTitle?: string | null | undefined;
  source?: string | null | undefined;
  title?: string | null | undefined;
  /** Structural parent index before the database self-reference is resolved. */
  parentChunkIndex?: number | null | undefined;
  parentChunkId?: number | null | undefined;
  kind?: 'parent' | 'child' | 'summary' | undefined;
  embeddingModel?: string | null | undefined;
  contentHash?: string | null | undefined;
}

/** Vector (embedding) retrieval, ranked by similarity. */
export interface VectorSearch {
  searchByVector(
    embedding: number[],
    opts: { threshold: number; limit: number; filter?: { documentId?: number }; signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
}

/** Lexical (BM25) retrieval ranked by ts_rank. */
export interface LexicalSearch {
  searchByLexical(
    query: string,
    opts: { limit: number; filter?: { documentId?: number }; signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
}

/** Relational chunk CRUD (parent/child self-FK resolution, ranges, counts). */
export interface ChunkStore {
  /** Fetch chunks by ids. Caller overrides `similarity`; used to resolve child→parent. */
  getByIds(ids: number[], opts?: { signal?: AbortSignal }): Promise<RetrievedChunkRow[]>;
  /** Fetch chunks in `[start, end]` range. Used by window parent-child mode. */
  getByDocAndRange(
    documentId: number,
    start: number,
    end: number,
    opts?: { signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
  /** Batched getByDocAndRange. Returns map keyed by `documentId:start:end`. */
  getByDocAndRanges(
    ranges: Array<{ documentId: number; start: number; end: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<Map<string, RetrievedChunkRow[]>>;
  insertMany(rows: InsertChunkInput[]): Promise<void>;
  /** Upsert a complete document chunk set by stable UID, then remove stale rows. */
  replaceMany?(documentId: number, rows: InsertChunkInput[]): Promise<void>;
  deleteByDocumentId(documentId: number): Promise<void>;
  countForDocuments(documentIds: number[]): Promise<Map<number, number>>;
  countForAll(): Promise<number>;
  countForDocument(documentId: number): Promise<number>;
  recountAll(): Promise<Array<{ documentId: number; count: number }>>;
}

/** The original composite surface, kept for existing consumers — signature-identical. */
export interface ChunkRepository extends VectorSearch, LexicalSearch, ChunkStore {
  searchByVector(
    embedding: number[],
    opts: { threshold: number; limit: number; filter?: { documentId?: number }; signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
  searchByLexical(
    query: string,
    opts: { limit: number; filter?: { documentId?: number }; signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
  getByIds(ids: number[], opts?: { signal?: AbortSignal }): Promise<RetrievedChunkRow[]>;
  getByDocAndRange(
    documentId: number,
    start: number,
    end: number,
    opts?: { signal?: AbortSignal },
  ): Promise<RetrievedChunkRow[]>;
  getByDocAndRanges(
    ranges: Array<{ documentId: number; start: number; end: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<Map<string, RetrievedChunkRow[]>>;
  insertMany(rows: InsertChunkInput[]): Promise<void>;
  deleteByDocumentId(documentId: number): Promise<void>;
  countForDocuments(documentIds: number[]): Promise<Map<number, number>>;
  countForAll(): Promise<number>;
  countForDocument(documentId: number): Promise<number>;
  recountAll(): Promise<Array<{ documentId: number; count: number }>>;
}
