// Port interfaces (abstractions). Living in @app/domain keeps the
// dependency graph unidirectional: domain ← application ← infrastructure.

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
  findByName(fileName: string): Promise<DocumentRow | null>;
  findById(id: number): Promise<DocumentRow | null>;
  setStorageKey(id: number, key: string): Promise<void>;
  updateIngestStatus(id: number, status: IngestStatus): Promise<void>;
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

export interface ChunkRepository {
  searchByVector(
    embedding: number[],
    opts: { threshold: number; limit: number },
  ): Promise<Array<{ content: string; similarity: number }>>;
  insertMany(rows: Array<{ documentId: number; content: string; embedding: number[] }>): Promise<void>;
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


export interface EmbeddingService {
  embed(value: string): Promise<number[]>;
  embedBatch(values: string[]): Promise<number[][]>;
}


export interface BlobStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  signedUrl?(key: string, ttlSec: number): Promise<string>;
}

// Async ingest queue; no-op in sync mode (QStash-backed).

export interface IngestQueue {
  enqueue(payload: { documentId: number }): Promise<void>;
}


export interface PdfParser {
  extractText(buffer: Buffer): Promise<string>;
}

export interface TextSplitter {
  splitText(text: string): Promise<string[]>;
}


/** Repositories scoped to the active DB transaction. */
export interface TransactionContext {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  audit: AuditLog;
  tickets: TicketRepository;
  users: UserRepository;
}

/** Runs a callback inside a DB transaction, scoped to a TransactionContext. */
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
  /** Resolves the active session (or null when signed out). */
  getSession(): Promise<{
    user: { id: string; email: string; name: string; imageUrl: string | null; role: 'admin' | 'user' };
  } | null>;
}
