import type {
  IngestDeps,
  SearchDeps,
  AgenticDeps,
  CacheLeasePolicy,
  CacheLeaseTelemetry,
} from '@app/application';
import { Llm, Auth, Pdf, Queue, Chunking, buildCoreDeps } from '@app/infrastructure';
import {
  CCH_ENABLED,
  defaultProcessEnv,
} from '@app/infrastructure/config';
import type { RerankerStatus } from '@app/infrastructure/llm';
import type { LogLevel } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import { configureLogger, ExternalServiceError, type Result, type IngestQueue, type Reranker } from '@app/domain';
import { getRuntimeConfig } from '../lib/config/runtime';
import { logger } from '../lib/logger';
import { after } from 'next/server';
import {
  tool,
  convertToModelMessages,
  streamText,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { ingestQueuedDocumentStandalone } from './rag';

const authAdapter = Auth.createAuthAdapter();

export const requireAdmin = authAdapter.requireAdmin;
export const requireSession = authAdapter.requireSession;
export const getAppSession = authAdapter.getAppSession;

const modelGateway = {
  streamText,
  tool,
  stepCountIs,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
};

export type ModelGateway = typeof modelGateway;
export { modelGateway };

export const core = buildCoreDeps({
  env: defaultProcessEnv,
  flushScheduler: after,
  onQueueIngest: async (documentId, fileHash) => {
    const result = await ingestQueuedDocumentStandalone(documentId, fileHash);
    if (!result.ok) throw new Error(`Inline ingest failed for document ${documentId}: ${result.error.message}`);
  },
  onAnswerCacheInitError: (error) => {
    logger.error(
      'UPSTASH_REDIS_REST_URL is set but the Upstash answer cache could not be initialized; falling back to in-memory cache. Provide UPSTASH_REDIS_REST_TOKEN or unset UPSTASH_REDIS_REST_URL.',
      { error },
    );
  },
});

configureLogger(core.config.LOG_LEVEL as LogLevel);

export const asyncIngest = Boolean(process.env.QSTASH_TOKEN);

export const { documentRepo, chunkRepo, settingsRepo, chatEventBatcher, chatFeedbackRepo, qualityReviewsRepo, chatHistoryRepo, embeddingService, blobStorage, cursorCodec, clock, hasher, runner } = core;

export const bind = <Args extends unknown[], T>(
  fn: (...args: Args) => Promise<Result<T>>,
  ...bound: Args
): Promise<Result<T>> => fn(...bound);

export const ingestQueue = core.ingestQueue;
export const rateLimiter = Auth.createFallbackRateLimiter({
  primary: core.rateLimiter,
  fallback: Auth.lruRateLimiter,
  onFallback: ({ key, error }) => {
    logger.warn('[rate-limit] provider failed; using the bounded local limiter', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

/**
 * Cross-instance single-flight is required in production. A process-local
 * coordinator is only enabled explicitly for local/degraded deployments.
 */
const configuredCacheLeasePolicy = process.env.CACHE_LEASE_MODE;
export const cacheLeasePolicy: CacheLeasePolicy = configuredCacheLeasePolicy === 'degraded'
  ? 'degraded'
  : configuredCacheLeasePolicy === 'strict' || process.env.NODE_ENV === 'production'
    ? 'strict'
    : 'degraded';
export const onCacheLeaseTelemetry = (event: CacheLeaseTelemetry): void => {
  logger.warn('chat.cache.lease_coordination', {
    operation: event.operation,
    result: event.result,
    policy: event.policy,
  });
};

if (process.env.NODE_ENV === 'production' && (process.env.BLOB_STORAGE_PROVIDER ?? 'filesystem') === 'filesystem') {
  logger.warn('BLOB_STORAGE_PROVIDER=filesystem with NODE_ENV=production: PDFs are written to the ephemeral local filesystem and will be lost between invocations. Use r2 or s3 in production.');
}

if (process.env.NODE_ENV === 'production' && !process.env.UPSTASH_REDIS_REST_URL) {
  logger.warn('NODE_ENV=production without UPSTASH_REDIS_REST_URL: answer cache and rate limiting fall back to in-memory state that is not shared across instances.');
}

export const reingestQueue: IngestQueue =
  process.env.QSTASH_TOKEN ? ingestQueue : Queue.createIngestQueue();

const ingestDeps: Omit<IngestDeps, 'chunkingStrategy'> = {
  documents: documentRepo, chunks: chunkRepo,
  embeddings: embeddingService, hasher,
  // Legacy fallback only: the canonical path is contentParser + chunkingStrategy.
  // pdfParser/textSplitter stay wired for SEED_LEGACY_SPLITTER seed compat.
  pdfParser: Pdf.unpdfParser, textSplitter: Pdf.langchainSplitter,
  contentParser: core.contentParser,
  runner,
  summarizer: Llm.createDocSummarizer(core.chatModelProvider, core.env),
  cchEnabled: CCH_ENABLED,
};

function buildChunkingStrategy(cfg: AppConfig) {
  return Chunking.getChunkingStrategy(cfg.chunkingStrategy, {
    embeddings: embeddingService,
    modelId: core.embeddingModelId,
    parentSize: cfg.parentChunkSize,
    childSize: cfg.childChunkSize,
  });
}

export async function resolveIngestDeps(): Promise<IngestDeps> {
  const cfg = await getRuntimeConfig();
  const cchEnabled = (cfg as unknown as { cchEnabled?: boolean }).cchEnabled ?? CCH_ENABLED;
  return { ...ingestDeps, cchEnabled, chunkingStrategy: buildChunkingStrategy(cfg) };
}

export type { RerankerStatus };

export function availableRerankers(): Map<string, RerankerStatus> {
  return core.availableRerankers();
}

export function resolveReranker(cfg: AppConfig): Reranker | undefined {
  return core.resolveReranker(cfg.rerankerProvider);
}

export function getSearchDeps(cfg: AppConfig): SearchDeps {
  return { chunks: chunkRepo, embeddings: embeddingService, reranker: resolveReranker(cfg) };
}

export function getAgenticDeps(cfg: AppConfig, signal?: AbortSignal): AgenticDeps {
  const aux = Llm.getAuxModels(undefined, cfg.auxModel, core.chatModelProvider, core.env);
  if (cfg.agenticQueryRewriteEnabled && !aux.queryRewriter) {
    throw new ExternalServiceError('Agentic retrieval is disabled (AGENTIC_ENABLED=false) but retrievalMode is agentic.');
  }
  return {
    search: getSearchDeps(cfg),
    queryRewriter: aux.queryRewriter!,
    retrieveLimit: cfg.agenticRetrieveLimit,
    maxRetries: cfg.agenticMaxRetries,
    stepBudget: cfg.agentStepBudget,
    rewriteEnabled: cfg.agenticQueryRewriteEnabled,
    similarityThreshold: cfg.similarityThreshold,
    hybridEnabled: cfg.hybridEnabled,
    signal,
  };
}

export const rateLimitDeps = { limiter: rateLimiter };
