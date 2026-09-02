/** Ingest lifecycle: `queued`→`ingesting`→`done`; `failed` is terminal despite QStash retry budget. */

export type IngestStatus = 'queued' | 'ingesting' | 'done' | 'failed';

import type { AppConfig } from './app-config';
import type { AdminListCursor, CursorContext, ListCursorCodec } from './pagination';

export type DocumentListCursor = Extract<AdminListCursor, { kind: 'documents' }>;
export type TicketListCursor = Extract<AdminListCursor, { kind: 'tickets' }>;
export type UserListCursor = Extract<AdminListCursor, { kind: 'users' }>;
export type AuditListCursor = Extract<AdminListCursor, { kind: 'audit' }>;

export interface CursorPageInfo {
  nextCursor: string | null;
  previousCursor: string | null;
}

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

/** Parses raw content (e.g. PDF bytes) into structured pages. Runtime-neutral: accepts `Uint8Array` (a `Buffer` satisfies it). */
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

export interface TicketRepository {
  findByTicketId(ticketId: string): Promise<TicketRow | null>;
  findByTicketIdForUpdate?(ticketId: string): Promise<TicketRow | null>;
  list(
    opts: {
      status?: 'created' | 'in_progress' | 'closed' | undefined;
      assignee?: string | null | undefined;
      search?: string | undefined;
      limit: number;
      offset?: number | undefined;
      cursor?: TicketListCursor | undefined;
      before?: TicketListCursor | undefined;
      cursorCodec?: ListCursorCodec | undefined;
      cursorContext?: CursorContext | undefined;
    },
  ): Promise<{ rows: TicketRow[]; total: number } & CursorPageInfo>;
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
  getTicketResponseTimes(range?: ChatEventRange): Promise<TicketResponseTimes>;
}

export interface UserRepository {
  upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
    emailVerified?: boolean | undefined;
  }): Promise<UserRow>;
  findByClerkId(clerkUserId: string): Promise<UserRow | null>;
  findByIds(clerkUserIds: string[]): Promise<UserRow[]>;
  setRole(clerkUserId: string, role: 'admin' | 'user'): Promise<UserRow | null>;
  /** Change a role only when the row still has the expected role. */
  setRoleIfCurrent?(
    clerkUserId: string,
    expectedRole: 'admin' | 'user',
    role: 'admin' | 'user',
  ): Promise<boolean>;
  touchLastSeen(clerkUserId: string): Promise<void>;
  list(opts: {
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: UserListCursor | undefined;
    before?: UserListCursor | undefined;
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
  }): Promise<{ rows: UserRow[]; total: number } & CursorPageInfo>;
  countAll(): Promise<number>;
  countAdmins(): Promise<number>;
  /** Count admin rows while holding row locks so concurrent demotions serialize on the same count. */
  countAdminsForUpdate(): Promise<number>;
}

type DocumentAuditAction = 'upload' | 'replace' | 'delete' | 'restore';
type TicketAuditAction =
  | 'create'
  | 'assign'
  | 'status_change'
  | 'note'
  | 'impersonation'
  | 'role_change';

export type AuditKind = 'document' | 'ticket' | 'user' | 'settings' | 'chat';

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
  kind?: AuditKind | undefined;
  action?: string | undefined;
  actorId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  documentId?: number | undefined;
  ticketId?: string | undefined;
  limit: number;
  offset?: number | undefined;
  cursor?: AuditListCursor | undefined;
  before?: AuditListCursor | undefined;
  cursorCodec?: ListCursorCodec | undefined;
  cursorContext?: CursorContext | undefined;
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
  /** Persist a dead-letter record whose primary write failed, for later replay. */
  recordDeadLetter(input: {
    kind: AuditKind | 'ingest' | 'chat_event';
    payload: unknown;
    error: string;
  }): Promise<void>;
  list(input: AuditListFilter): Promise<{
    events: AuditEventRecord[];
    total: number;
  } & CursorPageInfo>;
}

/** Per-turn chat metrics. `mode`: 'agentic' or 'vector'. */
export interface ChatEventInput {
  userId: string | null;
  query: string | null;
  mode: 'agentic' | 'vector';
  turnId?: string | null;
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
  from?: Date | undefined;
  to?: Date | undefined;
}

/** Aggregate per-turn metrics for the analytics dashboard. */
export interface ChatEventMetrics {
  total: number;
  ticketsCreated: number;
  ticketCreationRate: number;
  selfServeSuccessRate: number;
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

export interface ChatDailyTrendRow {
  day: string;
  total: number;
  hallucinations: number;
  outOfDomain: number;
  cacheHits: number;
  ticketsCreated: number;
  selfServe: number;
  avgMaxSimilarity: number;
  totalP50Ms: number;
  totalP95Ms: number;
  retrieveP50Ms: number;
  retrieveP95Ms: number;
  generateP50Ms: number;
  generateP95Ms: number;
  tokensIn: number;
  tokensOut: number;
}

export interface QueryLengthBuckets {
  short: number;
  medium: number;
  long: number;
}

export interface ModeComparison {
  mode: 'agentic' | 'vector';
  total: number;
  avgTokensPerQuery: number;
  avgMaxSimilarity: number;
  ticketRate: number;
  hallucinationRate: number;
  totalP50Ms: number;
  totalP95Ms: number;
  queryLengthBuckets: QueryLengthBuckets;
}

export interface CacheBusterQuery {
  query: string;
  misses: number;
}

export interface DocumentUtilityRow {
  documentId: number;
  fileName: string | null;
  retrievalCount: number;
  p95Similarity: number;
  ticketConversionRate: number;
}

export interface TurnToTicketBucket {
  label: string;
  turns: number;
  count: number;
}

export interface TurnsToTicket {
  ticketSessions: number;
  avgTurns: number;
  buckets: TurnToTicketBucket[];
}

export interface TicketResponseTimes {
  medianFirstResponseMs: number;
  medianResolutionMs: number;
  respondedCount: number;
  resolvedCount: number;
}

export interface ZeroHitDocument {
  documentId: number;
  fileName: string | null;
  createdAt: string;
}

export type FeedbackUpsertResult = 'ok' | 'not_found' | 'forbidden';

export interface ChatEvent {
  id: number;
  turnId: string | null;
  userId: string | null;
  query: string | null;
  mode: 'agentic' | 'vector';
  retrieveMs: number | null;
  generateMs: number | null;
  totalMs: number | null;
  hitCount: number | null;
  maxSimilarity: number | null;
  outOfDomain: boolean;
  hallucinationBlocked: boolean;
  cacheHit: boolean;
  ticketCreated: boolean;
  citationCount: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface ChatDailyQualityRow {
  day: string;
  avgFaithfulness: number;
  avgRetrievalRelevance: number;
}

export interface FeedbackSummary {
  up: number;
  down: number;
  total: number;
  totalEvents: number;
}

export interface DocumentSentiment {
  documentId: number;
  fileName: string | null;
  up: number;
  down: number;
}

export interface ThumbsDownDoc {
  documentId: number;
  fileName: string | null;
  down: number;
}

export interface ChatEventWriter {
  record(event: ChatEventInput): void;
  flush(): Promise<void>;
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}

export interface ChatEventReader {
  getQualitySamples(limit: number, filter: { blocked?: boolean }): Promise<ChatEvent[]>;
  getDailyTrends(days: number): Promise<ChatDailyTrendRow[]>;
  getDailyQuality(days: number): Promise<ChatDailyQualityRow[]>;
  getJudgeAverages(days?: number): Promise<{ avgFaithfulness: number; avgRetrievalRelevance: number }>;
  getMetrics(range?: ChatEventRange): Promise<ChatEventMetrics>;
  getUsageOverTime(days: number): Promise<ChatEventDailyUsage[]>;
  getModeComparison(range?: ChatEventRange): Promise<ModeComparison[]>;
  getCacheBusterQueries(limit: number, range?: ChatEventRange): Promise<CacheBusterQuery[]>;
  getDocumentUtility(limit: number, range?: ChatEventRange): Promise<DocumentUtilityRow[]>;
  getZeroHitDocuments(limit: number): Promise<ZeroHitDocument[]>;
  getTurnsToTicket(range?: ChatEventRange): Promise<TurnsToTicket>;
}

export interface ChatEventRetention {
  refreshDailyStats(): Promise<void>;
}

export interface ChatEventPurge {
  purgeOlderThan(cutoff: Date): Promise<{ deletedCount: number }>;
  purgeUserData(userId: string): Promise<{ deletedCount: number }>;
  anonymizeUserData(userId: string): Promise<{ updatedCount: number }>;
}

/** Per-turn metrics store. Buffers in memory, flushes on size/interval threshold. */
export type ChatEventsRepo = ChatEventWriter & ChatEventReader & ChatEventRetention & ChatEventPurge;

export type QualityReviewVerdict = 'good' | 'bad' | 'docs_missing';

export interface QualityReviewInput {
  turnId: string;
  reviewerId: string;
  verdict: QualityReviewVerdict;
  note?: string | null;
}

export interface QualityReviewRow {
  id: number;
  turnId: string | null;
  reviewerId: string | null;
  verdict: QualityReviewVerdict;
  note: string | null;
  createdAt: Date;
}

export interface QualityReviewsRepo {
  create(input: QualityReviewInput): Promise<QualityReviewRow>;
  listRecent(limit: number): Promise<QualityReviewRow[]>;
}

export interface ChatFeedbackRepo {
  upsertFeedback(input: {
    turnId: string;
    userId: string;
    feedback: 1 | -1;
    documentIds: number[];
    chunkIds: number[];
  }): Promise<FeedbackUpsertResult>;
  getFeedbackSummary(range?: ChatEventRange): Promise<FeedbackSummary>;
  getDocumentSentiment(limit: number, range?: ChatEventRange): Promise<DocumentSentiment[]>;
  getThumbsDownDocs(limit: number, range?: ChatEventRange): Promise<ThumbsDownDoc[]>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredChatMessage {
  id: number;
  turnId: string | null;
  role: 'user' | 'assistant';
  content: unknown;
  createdAt: Date;
}

export interface AppendChatTurnInput {
  conversationId: string;
  userId: string;
  turnId: string;
  /** Only read when creating the conversation. */
  title?: string | undefined;
  /** Client message id whose stored pair this turn replaces (regenerate). */
  retryOfMessageId?: string | undefined;
  userMessage: unknown;
  assistantMessage: unknown;
}

/** Persisted saved chats. Ownership is baked in: every method takes the owning `userId` first. */
export interface ChatHistoryRepo {
  appendTurn(input: AppendChatTurnInput): Promise<{ conversationId: string }>;
  listConversations(
    userId: string,
    opts: { limit: number; offset: number },
  ): Promise<ConversationSummary[]>;
  getConversation(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationSummary; messages: StoredChatMessage[] } | null>;
  renameConversation(userId: string, conversationId: string, title: string): Promise<boolean>;
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  countConversations(userId: string): Promise<number>;
  purgeOlderThan(cutoff: Date): Promise<{ deletedConversations: number; deletedMessages: number }>;
  purgeUserData(userId: string): Promise<{ deletedConversations: number; deletedMessages: number }>;
}

export interface RateLimiter {
  check(
    key: string,
    opts: { limit: number; windowMs: number },
  ): Promise<{ ok: true; remaining: number; resetMs: number } | { ok: false; retryAfterMs: number }>;
}

/** The result of trying to become the producer for one cache key. */
export type LeaseAcquireResult =
  | { kind: 'acquired'; handle: LeaseHandle }
  | { kind: 'held' }
  | { kind: 'unavailable' };

/** Result of extending an owned lease. */
export type LeaseRenewResult =
  | { kind: 'renewed' }
  | { kind: 'not-owner' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

/** Result of releasing an owned lease. */
export type LeaseReleaseResult =
  | { kind: 'released' }
  | { kind: 'not-owner' }
  | { kind: 'unavailable' };

/** Result of atomically publishing a value while ownership is still valid. */
export type LeasePublishResult =
  | { kind: 'published' }
  | { kind: 'not-owner' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

/**
 * Opaque ownership handle returned by a cache coordination provider.
 *
 * Provider tokens (for example Redis values) stay inside the adapter. The
 * application can only renew or release the ownership represented by this
 * handle and cannot accidentally mix a token with another cache key.
 */
export interface LeaseHandle {
  /** Adapters may disable renewal when the legacy provider cannot extend TTL. */
  readonly renewalSupported?: boolean;
  renew(ttlSec: number): Promise<LeaseRenewResult>;
  /** Distributed adapters use this to fence stale producers at publication. */
  publish?(value: string, ttlSec: number): Promise<LeasePublishResult>;
  release(): Promise<LeaseReleaseResult>;
}

/** Whether a coordination provider is process-local or shared by instances. */
export type CacheLeaseScope = 'local' | 'distributed';

/** Explicit single-flight coordination for one answer-cache provider. */
export interface CacheLeaseCoordinator {
  readonly scope: CacheLeaseScope;
  acquire(key: string, ttlSec: number): Promise<LeaseAcquireResult>;
}

/** Descriptive aliases for callers that refer to this port as single-flight. */
export type CacheCoordination = CacheLeaseCoordinator;
export type SingleFlightCoordinator = CacheLeaseCoordinator;

/**
 * Legacy token-shaped lease kept for source compatibility with older adapters.
 * New callers must use `AnswerCache.coordination`, whose handle hides tokens.
 */
export interface AnswerCacheLease {
  tryAcquire(key: string, ttlSec: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

/** Cache for query-keyed answers. Callers MUST pin model ids into the key. */
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, answer: string, ttlSec: number): Promise<void>;
  /** Explicit ownership coordination; absent only for legacy/test adapters. */
  coordination?: CacheLeaseCoordinator;
  /** @deprecated Use `coordination`; retained for older adapter consumers. */
  lease?: AnswerCacheLease;
}

export interface EmbeddingService {
  embed(value: string, opts?: { signal?: AbortSignal }): Promise<number[]>;
  embedBatch(values: string[], opts?: { signal?: AbortSignal }): Promise<number[][]>;
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

/** Why an answered turn was cut short by the turn deadline. */
export type FallbackReason = 'turn_deadline';

/** Final state of an agentic retrieval turn. */
export type AgenticResultState = 'ok' | 'empty';

/** Live quality-judge scores for one answered turn (0-1 each). */
export interface JudgeScores {
  retrievalRelevance: number;
  faithfulness: number;
  citationPrecision: number;
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
  enqueue(payload: { documentId: number; fileHash?: string; attemptId?: string }): Promise<void>;
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

/** Keyed environment lookup (process.env, test fakes, future non-Node runtimes). */
export interface EnvSource {
  get(key: string): string | undefined;
}

/** Frozen, typed, mirrors the current config/env.ts exports. */
export interface RuntimeConfig {
  readonly [key: string]: unknown;
}
