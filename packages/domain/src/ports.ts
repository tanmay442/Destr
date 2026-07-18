/** Ingest lifecycle: `queued`→`ingesting`→`done`; `failed` is terminal despite QStash retry budget. */

export type IngestStatus = 'queued' | 'ingesting' | 'done' | 'failed';

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

/**
 * A single pre-split chunk parsed from user-supplied Markdown. Produced by a
 * `MarkdownParser` adapter; maps onto `DocumentChunk`/`chunks` metadata columns
 * by the pre-chunked ingest use-case (Session 2). Kept in the domain so the
 * application + API layers can consume it without importing infrastructure.
 */
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
  title?: string | null; // CCH (Session 3)
  summary?: string | null; // CCH (Session 3)
  parentChunkId?: number | null; // parent-child (Session 5)
  sourceChunkId?: number | null; // proposition back-ref (future)
  /** Kind of chunk. `parent` = large block returned for context; `child` =
   *  small block embedded for precise retrieval; `summary` = LLM-generated
   *  summary (optional variant, Session 5). Defaults to `child`. */
  kind?: 'parent' | 'child' | 'summary';
  embeddingModel?: string | null;
  contentHash?: string | null;
}

/** Shape returned by vector/lookup queries: provenance + similarity. Shared by
 *  `searchByVector`, `getByIds`, and `getByDocAndRange` so resolution logic in
 *  the application layer can treat them uniformly. */
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
  extractText(buffer: Buffer): Promise<string>; // legacy fallback
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
  /** Lexical (BM25 / `tsvector`) retrieval. Returns chunks whose generated
   *  `tsv` matches the query, ranked by `ts_rank`, with `similarity` set to the
   *  (padded) rank score. Used by Session 7 hybrid retrieval alongside the
   *  vector branch; fused via Reciprocal Rank Fusion in `searchChunks`. */
  searchByLexical(
    query: string,
    opts: { limit: number; filter?: { documentId?: number } },
  ): Promise<RetrievedChunkRow[]>;
  /** Fetch chunks by their (surrogate) ids. Returns `RetrievedChunkRow`s with
   *  `similarity` left as a placeholder (the caller overrides it) — used to
   *  resolve child hits to their parent blocks (Session 5 parent-child). */
  getByIds(ids: number[]): Promise<RetrievedChunkRow[]>;
  /** Fetch chunks of a document whose `chunkIndex` lies in `[start, end]`
   *  (inclusive). Used by the `window` parent-child mode to pad a hit with its
   *  neighbours (Session 5). */
  getByDocAndRange(
    documentId: number,
    start: number,
    end: number,
  ): Promise<RetrievedChunkRow[]>;
  /** Batched variant of `getByDocAndRange` for window mode: one round-trip
   *  fetches neighbours for every `(documentId, start, end)` triple. Returns a
   *  map keyed by `documentId:start:end`. */
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

export interface AuditLog {
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
  list(input: {
    documentId?: number;
    ticketId?: string;
    limit: number;
    offset: number;
  }): Promise<{
    events: Array<{
      id: number;
      kind: 'document' | 'ticket';
      documentId: number | null;
      ticketId: string | null;
      actorId: string;
      actorName: string | null;
      action: string;
      at: Date;
    }>;
    total: number;
  }>;
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

/**
 * Short-lived cache for final, query-keyed answers (Session 10). Sits in front
 * of generation so repeat questions skip the LLM entirely. Because an answer is
 * tied to a specific embedding + chat model, callers MUST pin the model ids
 * into the cache key, otherwise a model swap silently serves stale text. The
 * adapter owns the transport (Upstash Redis / in-memory); the port never
 * encodes a key format.
 */
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, answer: string, ttlSec: number): Promise<void>;
}


export interface EmbeddingService {
  embed(value: string): Promise<number[]>;
  embedBatch(values: string[]): Promise<number[][]>;
}

/** A single reranked document: its position in the input `documents` array and
 *  the reranker's relevance score for the query (higher = more relevant). */
export interface RankedDocument {
  index: number;
  relevanceScore: number;
}

/**
 * Second-stage reranker (Session 6). Reorders an initial pool of retrieval
 * candidates by true query–document relevance. Unlike bi-encoder cosine
 * (pgvector), cross-encoders / hosted rerankers attend to the query and each
 * document jointly, giving markedly better precision on noisy corpora.
 *
 * `rank` receives the query and the candidate document texts and returns one
 * `RankedDocument` per input, each carrying the original `index` and a
 * `relevanceScore`. Implementations must not assume the results are sorted —
 * callers sort by `relevanceScore`. Implemented in infrastructure as
 * provider-agnostic adapters (local cross-encoder or hosted Cohere).
 */
export interface Reranker {
  rank(query: string, documents: string[]): Promise<RankedDocument[]>;
}

/**
 * Rewrites a vague user query into a tighter, more retrievable phrase
 * (Session 8 agentic loop). Provider-agnostic; adapters reuse the chat model
 * with structured output. The application layer depends only on this port.
 */
export interface QueryRewriter {
  rewrite(query: string): Promise<string>;
}

/**
 * Binary relevance grader for a single retrieved document against a question
 * (Session 8 agentic loop). Returns `'yes'` when the document helps answer the
 * question, `'no'` otherwise. Adapters reuse the chat model.
 */
export interface DocumentGrader {
  grade(question: string, document: string): Promise<'yes' | 'no'>;
}

/**
 * Hallucination grader: given the retrieved `documents` text and a `generation`,
 * returns `'yes'` when the answer is grounded in the documents, `'no'` when it
 * is not (Session 8 agentic loop). Adapters reuse the chat model.
 */
export interface HallucinationGrader {
  grade(documents: string, generation: string): Promise<'yes' | 'no'>;
}

/**
 * Generates a short document title + summary used to prepend a contextual
 * header to every chunk before embedding (Contextual Chunk Headers, Session 3).
 * Implemented in infrastructure as a provider-agnostic adapter built on top of
 * the configured chat model. The application layer depends only on this port.
 */
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
