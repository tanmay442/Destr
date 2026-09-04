import type { AppConfig } from '../app-config';
import type { ChunkRepository, DocumentRepository } from './documents';
import type { AuditLog, TicketRepository, UserRepository } from './admin';

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
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  signedUrl?(key: string, ttlSec: number): Promise<string>;
}

export interface IngestQueue {
  enqueue(payload: { documentId: number; fileHash?: string; attemptId?: string }): Promise<void>;
  isNoOp(): boolean;
}

export interface PdfParser {
  extractText(buffer: Uint8Array): Promise<string>;
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
  sha256(buf: Uint8Array): string;
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
