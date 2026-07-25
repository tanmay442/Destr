/** Ingest lifecycle: `queued`→`ingesting`→`done`; `failed` is terminal despite QStash retry budget. */

export type IngestStatus = 'queued' | 'ingesting' | 'done' | 'failed';

import type { AppConfig } from './app-config';

export interface DocumentRow {
  id: number;
  fileName: string;
  fileHash: string;
  uploadedBy: string;
  uploadedAt: Date;
  storageKey: string | null;
  ingestStatus: IngestStatus;
  deletedAt: Date | null;
}

export interface TicketRow {
  id: number;
  ticketId: string;
  userId: string;
  name: string;
  email: string;
  issue: string;
  status: 'created' | 'in_progress' | 'closed';
  createdAt: Date;
  assignedTo: string | null;
  notes: string | null;
}

export interface UserRow {
  clerkUserId: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  role: 'admin' | 'user';
  lastSeenAt: Date | null;
  createdAt: Date;
}


export interface DocumentRepository {
  findByName(fileName: string, opts?: { includeDeleted?: boolean }): Promise<DocumentRow | null>;
  findById(id: number, opts?: { includeDeleted?: boolean }): Promise<DocumentRow | null>;
  setStorageKey(id: number, key: string): Promise<void>;
  updateIngestStatus(id: number, status: IngestStatus): Promise<void>;
  /** Atomically flip `queued`→`ingesting`; returns true iff this caller won the claim. */
  claimIngest(id: number): Promise<boolean>;
  insert(input: { fileName: string; fileHash: string; uploadedBy: string }): Promise<DocumentRow>;
  /** Update mutable metadata of an existing row in place (keeps its id). */
  update(
    id: number,
    patch: { fileName?: string; fileHash?: string; uploadedBy?: string; ingestStatus?: IngestStatus },
  ): Promise<DocumentRow>;
  deleteById(id: number): Promise<void>;
  softDelete(id: number, at: Date): Promise<DocumentRow | null>;
  restore(id: number): Promise<DocumentRow | null>;
  list(opts: {
    search?: string;
    includeDeleted?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ documents: (DocumentRow & { hasBlob: boolean })[]; total: number }>;
  countChunksForDocuments(documentIds: number[]): Promise<Map<number, number>>;
  countChunksForAll(): Promise<number>;
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
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
  title?: string | null;
  summary?: string | null;
  parentChunkId?: number | null;
  sourceChunkId?: number | null;
  /** Kind of chunk: `parent` (large context block), `child` (embedded for retrieval), `summary` (LLM-generated). */
  kind?: 'parent' | 'child' | 'summary';
  embeddingModel?: string | null;
  contentHash?: string | null;
}

/** Shape returned by vector/lookup queries: provenance + similarity. */
export interface RetrievedChunkRow {
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
}

/** Parses raw content (e.g. PDF buffer) into structured pages. */
export interface ContentParser {
  extractPages(buffer: Buffer): Promise<Array<{ page: number; text: string }>>;
  extractText(buffer: Buffer): Promise<string>;
}

/** A chunking strategy that turns structured pages into DocumentChunk[]. */
export interface ChunkingStrategy {
  splitPages(pages: Array<{ page: number; text: string }>): Promise<DocumentChunk[]>;
}

export interface ChunkRepository {
  searchByVector(
    embedding: number[],
    opts: { threshold: number; limit: number; filter?: { documentId?: number } },
  ): Promise<RetrievedChunkRow[]>;
  /** Lexical (BM25) retrieval ranked by ts_rank. */
  searchByLexical(
    query: string,
    opts: { limit: number; filter?: { documentId?: number } },
  ): Promise<RetrievedChunkRow[]>;
  /** Fetch chunks by ids. Caller overrides `similarity`; used to resolve child→parent. */
  getByIds(ids: number[]): Promise<RetrievedChunkRow[]>;
  /** Fetch chunks in `[start, end]` range. Used by window parent-child mode. */
  getByDocAndRange(
    documentId: number,
    start: number,
    end: number,
  ): Promise<RetrievedChunkRow[]>;
  /** Batched getByDocAndRange. Returns map keyed by `documentId:start:end`. */
  getByDocAndRanges(
    ranges: Array<{ documentId: number; start: number; end: number }>,
  ): Promise<Map<string, RetrievedChunkRow[]>>;
  insertMany(
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
  ): Promise<void>;
  deleteByDocumentId(documentId: number): Promise<void>;
  countForDocuments(documentIds: number[]): Promise<Map<number, number>>;
  countForAll(): Promise<number>;
  countForDocument(documentId: number): Promise<number>;
  recountAll(): Promise<Array<{ documentId: number; count: number }>>;
}


export interface TicketRepository {
  findByTicketId(ticketId: string): Promise<TicketRow | null>;
  list(
    opts: {
      status?: 'created' | 'in_progress' | 'closed';
      assignee?: string | null;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ rows: TicketRow[]; total: number }>;
  latest(): Promise<{ id: number; ticketId: string } | null>;
  insert(input: {
    ticketId: string;
    userId: string;
    name: string;
    email: string;
    issue: string;
  }): Promise<TicketRow>;
  update(
    ticketId: string,
    patch: Partial<Pick<TicketRow, 'status' | 'assignedTo' | 'notes'>>,
  ): Promise<TicketRow | null>;
  countAll(): Promise<number>;
  countOpen(): Promise<number>;
}


export interface UserRepository {
  upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
  }): Promise<UserRow>;
  findByClerkId(clerkUserId: string): Promise<UserRow | null>;
  findByIds(clerkUserIds: string[]): Promise<UserRow[]>;
  setRole(clerkUserId: string, role: 'admin' | 'user'): Promise<UserRow | null>;
  touchLastSeen(clerkUserId: string): Promise<void>;
  list(opts: {
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: UserRow[]; total: number }>;
  countAll(): Promise<number>;
  countAdmins(): Promise<number>;
  syncClerkRole(clerkUserId: string, role: 'admin' | 'user'): Promise<void>;
}


type DocumentAuditAction = 'upload' | 'replace' | 'delete' | 'restore';
type TicketAuditAction =
  | 'create'
  | 'assign'
  | 'status_change'
  | 'note'
  | 'impersonation'
  | 'role_change';

export type AuditKind = 'document' | 'ticket' | 'user' | 'settings';

export interface AuditEventInput {
  kind: AuditKind;
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: number;
  kind: AuditKind;
  action: string;
  actorId: string;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  at: Date;
}

export interface AuditListFilter {
  kind?: AuditKind;
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  documentId?: number;
  ticketId?: string;
  limit: number;
  offset: number;
}

export interface AuditLog {
  /** Generic write into the single `audit_events` table. */
  logEvent(input: AuditEventInput): Promise<void>;
  logDocumentEvent(input: {
    action: DocumentAuditAction;
    documentId: number;
    actorId: string;
  }): Promise<void>;
  logTicketEvent(input: {
    action: TicketAuditAction;
    ticketId: string;
    actorId: string;
  }): Promise<void>;
  /** Record a dedicated user/role audit entry (separate from the ticket trail). */
  logUserEvent(input: {
    targetUserId: string;
    actorId: string;
    fromRole: 'admin' | 'user';
    toRole: 'admin' | 'user';
  }): Promise<void>;
  /** Persist an audit event whose primary write failed, for later replay. */
  recordDeadLetter(input: {
    kind: AuditKind;
    payload: unknown;
    error: string;
  }): Promise<void>;
  list(input: AuditListFilter): Promise<{
    events: AuditEventRecord[];
    total: number;
  }>;
}


/** Per-turn chat metrics. `mode`: 'agentic' or 'vector'. */
export interface ChatEventInput {
  userId: string | null;
  query: string | null;
  mode: 'agentic' | 'vector';
  retrieveMs?: number | null;
  generateMs?: number | null;
  totalMs?: number | null;
  hitCount?: number | null;
  maxSimilarity?: number | null;
  outOfDomain?: boolean;
  hallucinationBlocked?: boolean;
  cacheHit?: boolean;
  ticketCreated?: boolean;
  citationCount?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  meta?: Record<string, unknown>;
}

export interface ChatEventRange {
  from?: Date;
  to?: Date;
}

/** Aggregate per-turn metrics for the analytics dashboard. */
export interface ChatEventMetrics {
  total: number;
  ticketsCreated: number;
  deflectionRate: number;
  outOfDomainRate: number;
  zeroResultRate: number;
  cacheHitRate: number;
  hallucinationRate: number;
  agenticRetryRate: number;
  retrieveP50Ms: number;
  retrieveP95Ms: number;
  generateP50Ms: number;
  generateP95Ms: number;
  totalP50Ms: number;
  totalP95Ms: number;
  tokensIn: number;
  tokensOut: number;
  uniqueUsers: number;
  byMode: Array<{ mode: 'agentic' | 'vector'; total: number }>;
}

export interface ChatEventDailyUsage {
  day: string;
  total: number;
  uniqueUsers: number;
}

/** Per-turn metrics store. Buffers in memory, flushes on size/interval threshold. */
export interface ChatEventsRepo {
  record(event: ChatEventInput): void;
  flush(): Promise<void>;
  getMetrics(range?: ChatEventRange): Promise<ChatEventMetrics>;
  getTopZeroResultQueries(limit: number, range?: ChatEventRange): Promise<Array<{ q: string; count: number }>>;
  getUsageOverTime(days: number): Promise<ChatEventDailyUsage[]>;
  refreshDailyStats(): Promise<void>;
  purgeOlderThan(cutoff: Date): Promise<{ deletedCount: number }>;
  purgeUserData(userId: string): Promise<{ deletedCount: number }>;
  anonymizeUserData(userId: string): Promise<{ updatedCount: number }>;
}


export interface RateLimiter {
  check(
    key: string,
    opts: { limit: number; windowMs: number },
  ): Promise<{ ok: true; remaining: number; resetMs: number } | { ok: false; retryAfterMs: number }>;
}

export interface QueryStats {
  record(userId: string, query: string): Promise<void>;
  top(limit: number): Promise<Array<{ q: string; count: number }>>;
}

/** Cache for query-keyed answers. Callers MUST pin model ids into the key. */
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, answer: string, ttlSec: number): Promise<void>;
}


export interface EmbeddingService {
  embed(value: string): Promise<number[]>;
  embedBatch(values: string[]): Promise<number[][]>;
}

/** A reranked document with original index and relevance score. */
export interface RankedDocument {
  index: number;
  relevanceScore: number;
}

/** Second-stage reranker: reorders retrieval candidates by query-document relevance. */
export interface Reranker {
  rank(query: string, documents: string[]): Promise<RankedDocument[]>;
}

/** Rewrites a vague user query into a tighter, more retrievable phrase. */
export interface QueryRewriter {
  rewrite(query: string): Promise<string>;
}

/** Binary relevance grader: returns 'yes' if document helps answer the question. */
export interface DocumentGrader {
  grade(question: string, document: string): Promise<'yes' | 'no'>;
}

/** Hallucination grader: returns 'yes' when generation is grounded in documents. */
export interface HallucinationGrader {
  grade(documents: string, generation: string): Promise<'yes' | 'no'>;
}

/** Generates a short document title + summary for contextual chunk headers. */
export interface DocSummarizer {
  generateDocContext(text: string): Promise<{ title: string; summary: string }>;
}


export interface BlobStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  signedUrl?(key: string, ttlSec: number): Promise<string>;
}


export interface IngestQueue {
  enqueue(payload: { documentId: number }): Promise<void>;
  isNoOp(): boolean;
}


export interface PdfParser {
  extractText(buffer: Buffer): Promise<string>;
}

export interface TextSplitter {
  splitText(text: string): Promise<string[]>;
}


export interface TransactionContext {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  audit: AuditLog;
  tickets: TicketRepository;
  users: UserRepository;
}

export interface TransactionRunner {
  run<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface Hasher {
  sha256(buf: Buffer): string;
}

export interface SessionStore {
  getSession(): Promise<{
    user: { id: string; email: string; name: string; imageUrl: string | null; role: 'admin' | 'user' };
  } | null>;
}

/** Runtime configuration override store with optimistic concurrency (version field). */
export interface SettingsRepo {
  getOverrides(): Promise<{ overrides: Partial<AppConfig>; version: number }>;
  saveOverrides(input: {
    patch: Partial<AppConfig>;
    actorId: string;
    expectedVersion: number;
  }): Promise<{ version: number } | { conflict: true }>;
}
