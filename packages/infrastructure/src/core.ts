import type {
  AnswerCache,
  AuditLog,
  BlobStorage,
  ChatEventsRepo,
  ChatFeedbackRepo,
  ChatHistoryRepo,
  ChunkRepository,
  DocumentRepository,
  EmbeddingService,
  EnvSource,
  IngestQueue,
  RateLimiter,
  Reranker,
  RuntimeConfig,
  SettingsRepo,
  TicketRepository,
  UserRepository,
} from '@app/domain';
import { loadEnvConfig, defaultProcessEnv } from './config/env';
import {
  createDbClient,
  db,
  createDocumentRepo,
  createChunkRepo,
  createTicketRepo,
  createUserRepo,
  createAuditRepo,
  createSettingsRepo,
  createChatEventsRepo,
  createChatFeedbackRepo,
  createChatHistoryRepo,
} from './db';
import {
  getEmbeddingService,
  availableRerankers,
  resolveReranker,
  type RerankerStatus,
} from './llm';
import { createBlobStorage } from './storage/blob-storage-factory';
import { createIngestQueue } from './queue';
import './auth/upstash-rate-limiter';
import './auth/upstash-answer-cache';
import { createRateLimiter } from './auth/lru-rate-limiter';
import { createAnswerCache } from './auth/in-memory-answer-cache';

export interface CoreDepsOptions {
  env?: EnvSource;
  onQueueIngest?: (documentId: number) => Promise<void>;
  onAnswerCacheInitError?: (error: unknown) => void;
  flushScheduler?: (fn: () => void) => void;
}

export interface CoreDeps {
  config: RuntimeConfig;
  dbClient: ReturnType<typeof createDbClient>;
  documentRepo: DocumentRepository;
  chunkRepo: ChunkRepository;
  ticketRepo: TicketRepository;
  userRepo: UserRepository;
  auditRepo: AuditLog;
  settingsRepo: SettingsRepo;
  chatEventBatcher: ChatEventsRepo;
  chatFeedbackRepo: ChatFeedbackRepo;
  chatHistoryRepo: ChatHistoryRepo;
  embeddingService: EmbeddingService;
  blobStorage: BlobStorage;
  ingestQueue: IngestQueue;
  rateLimiter: RateLimiter;
  answerCache: AnswerCache;
  resolveReranker: (provider: string) => Reranker | undefined;
  availableRerankers: () => Map<string, RerankerStatus>;
}

function constructCoreDeps(options: CoreDepsOptions, env: EnvSource): CoreDeps {
  const config = loadEnvConfig(env);
  const dbClient = env === defaultProcessEnv ? db : createDbClient({ env });
  return {
    config,
    dbClient,
    documentRepo: createDocumentRepo(dbClient),
    chunkRepo: createChunkRepo(dbClient),
    ticketRepo: createTicketRepo(dbClient),
    userRepo: createUserRepo(dbClient),
    auditRepo: createAuditRepo(dbClient),
    settingsRepo: createSettingsRepo(dbClient),
    chatEventBatcher: createChatEventsRepo(
      dbClient,
      options.flushScheduler ? { flushScheduler: options.flushScheduler } : {},
    ),
    chatFeedbackRepo: createChatFeedbackRepo(dbClient),
    chatHistoryRepo: createChatHistoryRepo(dbClient),
    embeddingService: getEmbeddingService(),
    blobStorage: createBlobStorage(),
    ingestQueue: createIngestQueue(options.onQueueIngest ? { ingest: options.onQueueIngest } : {}),
    rateLimiter: createRateLimiter(),
    answerCache: createAnswerCache(options.onAnswerCacheInitError),
    resolveReranker,
    availableRerankers,
  };
}

let _defaultCore: CoreDeps | undefined;

/**
 * Builds or returns the shared core dependencies singleton for the default process environment.
 *
 * INTENTIONAL DESIGN:
 * - For `defaultProcessEnv`, `buildCoreDeps` memoizes `_defaultCore` on the first call.
 * - This prevents spawning duplicate database connection pools or duplicate background timers in the process.
 * - Note: Options passed on subsequent calls for defaultProcessEnv are ignored (first caller wins).
 * - If a caller requires isolated core dependencies (e.g. test suites), pass an explicit non-default `env`.
 */
export function buildCoreDeps(options: CoreDepsOptions = {}): CoreDeps {
  const env = options.env ?? defaultProcessEnv;
  if (env !== defaultProcessEnv) {
    return constructCoreDeps(options, env);
  }
  _defaultCore ??= constructCoreDeps(options, env);
  return _defaultCore;
}
