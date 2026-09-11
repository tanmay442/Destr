import { z } from 'zod';
import type {
  AnswerCache,
  AgenticResultState,
  ChatEventInput,
  RateLimiter,
  Result,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { AgenticResult } from '../../rag/agentic-search';
import type {
  RetrievalSignal,
  SearchChunksResult,
  SearchFailure,
} from '../../rag/search';
import type { OrchestratorResult } from '../../agent/search/search-orchestrator';
import type { SearchBudgetLimits } from '../../agent/search/search-budget';
import type { ChatChunk, ChatModelRef, ChatProviderOptions, ChatStreamWriter } from '../chat-chunks';
import type { AgentModelBackend } from '../../agent/model-backend';
import type {
  CacheLeasePolicy,
  CacheLeaseTelemetry,
} from '../cache-lease';

/**
 * Narrow model-invocation seam. The application selects tools and owns the
 * agent loop; infrastructure executes single model steps behind this port.
 * Provider option keys and response parsing stay in infrastructure adapters.
 */
export interface ChatTurnModelPort {
  createStream(input: {
    readonly execute: (writer: ChatStreamWriter) => void;
  }): ReadableStream<ChatChunk>;
  defineTool(input: {
    readonly description: string;
    readonly inputSchema: unknown;
    readonly outputSchema?: unknown;
    readonly inputExamples?: readonly { readonly input: unknown }[] | undefined;
    readonly strict?: boolean | undefined;
  }): unknown;
  createModelBackend(input: {
    readonly model: ChatModelRef;
    readonly tools: Readonly<Record<string, unknown>>;
    readonly providerOptions?: ChatProviderOptions | undefined;
    readonly maxOutputTokens?: number | undefined;
  }): AgentModelBackend;
}

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
  providerOptions?: ChatProviderOptions;
  telemetry?: Record<string, unknown>;
  parseUsage?: (usage: unknown, providerMetadata?: unknown) => ChatModelUsageTelemetry;
}

export interface StructuredSearchOptions {
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
  excludeChunkIdentities?: ReadonlySet<string> | undefined;
  budgets?: Partial<SearchBudgetLimits> | undefined;
  deadlineAt?: number | undefined;
  shadow?: boolean | undefined;
  trace?: {
    write(event: { toolName: string; callId: string; phase: 'error'; durationMs: number | null }): void;
  } | undefined;
}

export interface ChatTurnDeps {
  modelGateway: ChatTurnModelPort;
  getChatModel(): ChatModelRef;
  getChatModelId(): string;
  /** Trusted origins from which the configured model provider may fetch files. */
  allowedChatFileOrigins?: ReadonlySet<string>;
  getChatModelRequestOptions?: (input: {
    stablePromptPrefix: string;
    prefixVersion: string;
  }) => ChatModelRequestOptions | undefined;
  /** Provider-neutral retrieval adapter identity; raw queries are never included. */
  getRetrievalProvider?: () => string;
  /** Provider-neutral tool capability facts; provider option keys stay in infrastructure. */
  getModelToolCapabilities?: () => {
    strictSchemas: 'native' | 'emulated' | 'unsupported';
    inputExamples: 'native' | 'description_middleware' | 'unsupported';
    outputSchemas: 'native' | 'validated_locally';
    parallelCalls: boolean;
    toolCallRepair: 'supported' | 'unsupported';
    approvalHooks: 'native' | 'application';
  };
  getEmbeddingModelId(): string;
  getRuntimeConfig(): Promise<AppConfig>;
  searchChunks(
    cfg: AppConfig,
    query: string,
    opts: {
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
      excludeChunkIdentities?: ReadonlySet<string> | undefined;
    },
  ): Promise<SearchChunksResult>;
  agenticSearch(
    cfg: AppConfig,
    query: string,
    opts?: {
      limit?: number | undefined;
      signal?: AbortSignal | undefined;
      excludeChunkIdentities?: ReadonlySet<string> | undefined;
    },
  ): Promise<Result<AgenticResult, SearchFailure>>;
  structuredSearch?: (
    cfg: AppConfig,
    query: string,
    opts?: StructuredSearchOptions,
  ) => Promise<OrchestratorResult>;
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
  }, opts?: { readonly signal?: AbortSignal | undefined }): Promise<Result<{ ticketId: string; status: 'created' }>>;
  userResolver(
    req: Request,
    opts?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ userId: string; name?: string; email?: string }>;
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
      stream: ReadableStream<ChatChunk>;
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
  maxRetrievalScores: Partial<Record<RetrievalSignal, number>>;
  searchResultStates: AgenticResultState[];
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
