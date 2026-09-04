import type {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  InferUIMessageChunk,
} from 'ai';
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { z } from 'zod';
import type {
  AnswerCache,
  ChatEventInput,
  RateLimiter,
  Result,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { AgenticResult } from '../../rag/agentic-search';
import type { RetrievedChunk } from '../../rag/search';
import type { ChatUIMessage } from '../message-types';
import type {
  CacheLeasePolicy,
  CacheLeaseTelemetry,
} from '../cache-lease';

type UIMessage = ChatUIMessage;

export type AiSdk = {
  streamText: typeof streamText;
  tool: typeof tool;
  stepCountIs: typeof stepCountIs;
  convertToModelMessages: typeof convertToModelMessages;
  createUIMessageStream: typeof createUIMessageStream;
};

/** Provider-neutral usage facts returned by an infrastructure model adapter. */
export interface ChatModelUsageTelemetry {
  inputTokens: number | null;
  inputTokensStatus: 'reported' | 'unsupported';
  cachedInputTokens: number | null;
  cachedInputTokensStatus: 'reported' | 'unsupported';
  cacheReadTokens: number | null;
  cacheReadStatus: 'reported' | 'unsupported';
  cacheWriteTokens: number | null;
  cacheWriteStatus: 'reported' | 'unsupported';
  cacheHitRatio: number | null;
}

/**
 * The application receives a generic adapter callback. Provider-specific
 * option keys, capability objects, and parsing remain inside infrastructure.
 */
export interface ChatModelRequestOptions {
  providerOptions?: SharedV3ProviderOptions;
  telemetry?: Record<string, unknown>;
  parseUsage?: (usage: unknown, providerMetadata?: unknown) => ChatModelUsageTelemetry;
}

export interface ChatTurnDeps {
  ai: AiSdk;
  getChatModel(): LanguageModelV3;
  getChatModelId(): string;
  /** Trusted origins from which the configured model provider may fetch files. */
  allowedChatFileOrigins?: ReadonlySet<string>;
  getChatModelRequestOptions?: (input: {
    stablePromptPrefix: string;
    prefixVersion: string;
  }) => ChatModelRequestOptions | undefined;
  /** Provider-neutral retrieval adapter identity; raw queries are never included. */
  getRetrievalProvider?: () => string;
  getEmbeddingModelId(): string;
  getRuntimeConfig(): Promise<AppConfig>;
  searchChunks(
    cfg: AppConfig,
    query: string,
    opts: { limit?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<Result<RetrievedChunk[]>>;
  agenticSearch(
    cfg: AppConfig,
    query: string,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<Result<AgenticResult>>;
  hallucinationGrader(
    cfg: AppConfig,
  ): ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  answerCache: AnswerCache;
  turnResultCache?: AnswerCache;
  answerCacheKey(
    query: string,
    ctx: { embeddingModel: string; chatModel: string; userId?: string; fingerprint?: string },
  ): string;
  /** Strict in production; degraded is an explicit local-development mode. */
  cacheLeasePolicy?: CacheLeasePolicy;
  /** Receives rate-limited lease availability/ownership diagnostics. */
  onCacheLeaseTelemetry?: (event: CacheLeaseTelemetry) => void;
  rateLimit: RateLimiter;
  createTicket(input: {
    userId: string;
    name: string;
    email: string;
    issue: string;
  }): Promise<Result<{ ticketId: string; status: 'created' }>>;
  userResolver(req: Request): Promise<{ userId: string; name?: string; email?: string }>;
  eventSink: {
    record(event: ChatEventInput): void;
    flush(): Promise<void>;
  };
  historySink?: {
    appendTurn(input: {
      userId: string;
      conversationId: string;
      turnId: string;
      retryOfMessageId?: string | undefined;
      title?: string | undefined;
      userMessage: unknown;
      assistantMessage: unknown;
    }): Promise<unknown>;
  };
  /** Schedules a deferred task. */
  judgeScheduler?: (task: () => Promise<void>) => void;

  qualityJudge?: (ctx: {
    question: string;
    snippets: string[];
    documents: string;
    answer: string;
    turnId: string;
  }) => Promise<void>;

  turnSoftDeadlineMs?: number;

  judgeMaxWallMs?: number;
  traceEnabled: boolean;
}

export interface ChatTurnRequest {
  request: Request;
  userId: string;
  startedAt?: number;
}

export type ChatTurnResult =
  | {
      kind: 'stream';
      stream: ReadableStream<InferUIMessageChunk<UIMessage>>;
      meta: { turnId: string | null; mode: 'vector' | 'agentic'; cacheHit: boolean };
    }
  | { kind: 'rate-limited'; retryAfterSec: string | undefined }
  | { kind: 'cache-wait-timeout' }
  | { kind: 'cache-unavailable' }
  | { kind: 'idempotency-conflict' }
  | { kind: 'payload-too-large' }
  | { kind: 'invalid-request'; issues: z.ZodIssue[] };

interface TurnMetrics {
  retrieveMs: number;
  prefetchMs: number | null;
  prefetchStatus: 'disabled' | 'performed' | 'exact_match_reused' | 'query_changed';
  firstTokenMs: number | null;
  hallucinationMs: number | null;
  hitCount: number | null;
  maxSimilarity: number | null;
  ticketCreated: boolean;
  ticketId: string | null;
  rewritten: boolean;
  reformulationCount: number;
}

export type { TurnMetrics };

interface GenerationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type { GenerationUsage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseGenerationUsage(value: unknown): GenerationUsage {
  if (!isRecord(value)) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: nonnegativeNumber(value.inputTokens),
    outputTokens: nonnegativeNumber(value.outputTokens),
  };
}

export { parseGenerationUsage };
