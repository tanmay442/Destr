import type {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  InferUIMessageChunk,
} from 'ai';
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CHAT_MAX_BODY_BYTES,
  CHAT_RATE_LIMIT,
  logger,
  MAX_DURATION_MS,
  sanitizeText,
  TURN_DEADLINE_BANNER_MESSAGE,
  TURN_DEADLINE_TEXT,
  type AgenticResultState,
  type AnswerCache,
  type ChatEventInput,
  type RateLimiter,
  type Result,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import {
  buildStableSystemPrompt,
  buildSystemPrompt,
  SYSTEM_PROMPT_PREFIX_VERSION,
} from '../prompt/build-system-prompt';
import type { AgenticResult } from '../rag/agentic-search';
import type { RetrievedChunk } from '../rag/search';
import { cacheFingerprint } from './cache-key';
import { buildEventMeta } from './build-event-meta';
import { shouldCache } from './should-cache';
import { buildAssistantMessageLike, type MessageLike } from './history';
import { dedupeCitations } from './dedupe-citations';
import { citationDocumentIds, type EmittedCitation } from './emit-citations';
import { addGroundingEvidence, createGroundingEvidence, formatGroundingReference, type GroundingEvidence } from './grounding-evidence';
import { createChatRequestSchema } from './request-schema';
import { resolveTurnId } from './turn-id';
import {
  compactModelHistory,
  toChatUIMessages,
  type ChatInputMessage,
  type ChatUIMessage,
} from './message-types';
import {
  createCacheLease,
  waitForCachedAnswer,
  type CacheLease,
  type CacheLeaseOptions,
  type CacheLeasePolicy,
  type CacheLeaseTelemetry,
} from './cache-lease';
import {
  legacyTurnRequestFingerprint,
  turnRequestFingerprint,
  TURN_FINGERPRINT_VERSION,
} from './turn-fingerprint';

type UIMessage = ChatUIMessage;

const TURN_RESULT_CACHE_TTL_SEC = 86_400;

interface CachedAnswerPayload {
  text: string;
  citations: EmittedCitation[];
  requestFingerprint?: string;
  fingerprintVersion?: number;
  guardrail?: {
    outOfDomain: boolean;
    offerTicket: boolean;
    notice?: boolean;
    message?: string;
    isEmpty?: boolean;
    resultState?: string;
  };
}

function parseCachedAnswer(value: string): CachedAnswerPayload;
function parseCachedAnswer(value: string, expectedKind: 'turn-result'): CachedAnswerPayload | null;
function parseCachedAnswer(value: string, expectedKind?: 'turn-result'): CachedAnswerPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as {
        v?: unknown;
        kind?: unknown;
        text?: unknown;
        citations?: unknown;
        requestFingerprint?: unknown;
        fingerprintVersion?: unknown;
        guardrail?: unknown;
      };
      if (
        candidate.v === 1 &&
        (expectedKind === undefined || candidate.kind === expectedKind) &&
        typeof candidate.text === 'string' &&
        Array.isArray(candidate.citations) &&
        candidate.citations.every(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Record<string, unknown>).snippet === 'string',
        )
      ) {
        const result: CachedAnswerPayload = {
          text: candidate.text,
          citations: candidate.citations as EmittedCitation[],
        };
        if (typeof candidate.requestFingerprint === 'string') {
          result.requestFingerprint = candidate.requestFingerprint;
        };
        if (typeof candidate.fingerprintVersion === 'number') {
          result.fingerprintVersion = candidate.fingerprintVersion;
        }
        if (typeof candidate.guardrail === 'object' && candidate.guardrail !== null) {
          result.guardrail = candidate.guardrail as NonNullable<CachedAnswerPayload['guardrail']>;
        }
        return result;
      }
    }
  } catch {
  }
  return expectedKind === undefined ? { text: value, citations: [] } : null;
}

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

function parseTurnResult(
  value: string,
  requestFingerprint: { current: string; legacy: string },
): { answer: CachedAnswerPayload } | { conflict: true } | null {
  const answer = parseCachedAnswer(value, 'turn-result');
  if (!answer) return null;
  const expected = answer.fingerprintVersion === TURN_FINGERPRINT_VERSION
    ? requestFingerprint.current
    : requestFingerprint.legacy;
  if (answer.requestFingerprint !== expected) return { conflict: true };
  return { answer };
}

function createCachedAnswerStream(
  ai: AiSdk,
  cachedAnswer: CachedAnswerPayload,
  historyPersisted: boolean,
  conversationId: string | undefined,
): ReadableStream<InferUIMessageChunk<UIMessage>> {
  return ai.createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'text-start', id: 'cached' });
      writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
      writer.write({ type: 'text-end', id: 'cached' });
      for (const citation of dedupeCitations(cachedAnswer.citations)) {
        writer.write({ type: 'data-citation', data: citation });
      }
      if (cachedAnswer.guardrail) {
        writer.write({ type: 'data-guardrail', data: cachedAnswer.guardrail });
      }
      if (historyPersisted && conversationId) {
        writer.write({
          type: 'data-conversation-persisted',
          data: { conversationId },
        });
      }
    },
  });
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

/** Best-effort history persistence; callers wait before closing a completed stream. */
export async function persistHistory(
  sink: ChatTurnDeps['historySink'],
  cfg: AppConfig,
  userId: string,
  input: {
    conversationId: string | undefined;
    turnId: string | null;
    retryOfMessageId?: string | undefined;
    title: string;
    userMessage: MessageLike | undefined;
    assistantMessage: MessageLike;
  },
): Promise<boolean> {
  if (!cfg.captureQueryText || !sink || !input.turnId || !input.userMessage) return false;
  if (!input.conversationId) {
    logger.debug('chat.history.persist_skipped', { turnId: input.turnId });
    return false;
  }
  try {
    await sink.appendTurn({
      userId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      retryOfMessageId: input.retryOfMessageId,
      title: input.title,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
    });
    return true;
  } catch (cause: unknown) {
    logger.error('chat.history.persist_failed', {
      conversationId: input.conversationId,
      turnId: input.turnId,
      error: String(cause),
    });
    return false;
  }
}

async function readBoundedJson(request: Request): Promise<{ value: unknown; tooLarge: boolean }> {
  if (!request.body) return { value: null, tooLarge: false };
  const abortedBeforeRead = request.signal.aborted;
  const reader = request.body.getReader();
  const abortHandler = (): void => {
    reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', abortHandler, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (!abortedBeforeRead && request.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        return { value: null, tooLarge: false };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > CHAT_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { value: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { value: null, tooLarge: false };
  } finally {
    request.signal.removeEventListener('abort', abortHandler);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), tooLarge: false };
  } catch (e) {
    logger.debug('JSON parse failed', { error: String(e) });
    return { value: null, tooLarge: false };
  }
}

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

interface GenerationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

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

function buildChatTools(deps: ChatTurnDeps, opts: {
  cfg: AppConfig;
  effectiveMode: 'agentic' | 'normal';
  userId: string;
  request: Request;
  groundingEvidence: GroundingEvidence;
  outOfDomainRef: { value: boolean };
  isEmptyRef: { value: boolean };
  resultStateRef: { value: AgenticResultState | null };
  metrics: TurnMetrics;
  prefetched?: { query: string; matches: RetrievedChunk[] } | undefined;
}) {
  const {
    cfg,
    effectiveMode,
    userId,
    request,
    groundingEvidence,
    outOfDomainRef,
    isEmptyRef,
    resultStateRef,
    metrics,
    prefetched,
  } = opts;
  let ticketOpenedInTurn = false;
  let prefetchedConsumed = false;
  let prefetchQueryChanged = false;
  return {
    searchDocumentation: deps.ai.tool({
      description:
        "Search the org documentation for chunks relevant to the user's question. Returns an array of { content, similarity, documentTitle, section } objects, ordered by similarity (highest first). Call this tool whenever you need to ground an answer in the official docs. You may call it more than once with a reformulated query if the first call returns nothing useful. Each `content` is capped at 800 characters; duplicate chunks are omitted across this turn. Do NOT call this for non-documentation questions (medical, legal, personal).",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            'A focused, specific search query. Reformulate vague user wording into a tight phrase (e.g. "school cell phone policy" instead of "phones").',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            'Maximum number of chunks to return. Defaults to 3. Use a larger value only if the first call returned nothing useful.',
          ),
      }),
      execute: async ({ query, limit }) => {
        let matches: RetrievedChunk[];
        const t0 = performance.now();
        const canReusePrefetch =
          !prefetchedConsumed &&
          prefetched !== undefined &&
          prefetched.query.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase();
        if (canReusePrefetch) {
          prefetchedConsumed = true;
          metrics.prefetchStatus = 'exact_match_reused';
          matches = prefetched.matches;
          for (const match of matches) {
            if (metrics.maxSimilarity === null || match.similarity > metrics.maxSimilarity) {
              metrics.maxSimilarity = match.similarity;
            }
          }
          metrics.hitCount = (metrics.hitCount ?? 0) + matches.length;
          return matches.map((match) => ({
            content: formatGroundingReference(match),
            similarity: match.similarity,
            documentTitle: match.title ?? undefined,
            section: match.sectionTitle ?? undefined,
          }));
        }
        if (prefetched !== undefined && !prefetchQueryChanged) {
          prefetchQueryChanged = true;
          metrics.prefetchStatus = 'query_changed';
          metrics.reformulationCount += 1;
        }
        if (effectiveMode === 'agentic') {
          const r = await deps.agenticSearch(cfg, query, { signal: request.signal });
          if (!r.ok) {
            logger.error('Agentic retrieval failed', { error: r.error });
            metrics.retrieveMs += Math.round(performance.now() - t0);
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'agentic', query, ms: performance.now() - t0, hits: r.value.chunks.length });
          }
          const hadEvidence = groundingEvidence.documents.length > 0;
          if (r.value.chunks.length > 0 || hadEvidence) {
            outOfDomainRef.value = false;
            isEmptyRef.value = false;
            resultStateRef.value = 'ok';
          } else {
            outOfDomainRef.value = r.value.outOfDomain;
            isEmptyRef.value = r.value.isEmpty;
            resultStateRef.value = r.value.resultState;
          }
          if (r.value.rewrittenQuery && r.value.rewrittenQuery !== query) {
            metrics.rewritten = true;
            metrics.reformulationCount += 1;
          }
          matches = r.value.chunks;
        } else {
          const r = await deps.searchChunks(cfg, query, { limit, signal: request.signal });
          if (!r.ok) {
            logger.error('RAG retrieval failed', { error: r.error });
            metrics.retrieveMs += Math.round(performance.now() - t0);
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'vector', query, ms: performance.now() - t0, hits: r.value.length });
          }
          matches = r.value;
        }
        metrics.retrieveMs += Math.round(performance.now() - t0);
        for (const m of matches) {
          if (metrics.maxSimilarity === null || m.similarity > metrics.maxSimilarity) metrics.maxSimilarity = m.similarity;
        }
        const uniqueMatches = addGroundingEvidence(groundingEvidence, matches);
        metrics.hitCount = (metrics.hitCount ?? 0) + uniqueMatches.length;
        return uniqueMatches.map((m) => ({
          content: formatGroundingReference(m),
          similarity: m.similarity,
          documentTitle: m.title ?? undefined,
          section: m.sectionTitle ?? undefined,
        }));
      },
    }),
    createKnowledgeTicket: deps.ai.tool({
      description:
        'Open a knowledge ticket. Invoke this tool when the user\'s issue cannot be resolved via the available documentation content or the user has explicitly asked to open one, file one, escalate, talk to a human, or submit a complaint. When invoking, provide a structured `issue` summary with appropriate context so the reviewer can understand the full situation without reading the transcript: Product / Question / What was tried / Docs searched / User context.',
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Ignored by the server \u2014 the signed-in user's name is used instead.",
          ),
        email: z
          .string()
          .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)
          .describe(
            "Ignored by the server \u2014 the signed-in user's email is used instead.",
          ),
        issue: z
          .string()
          .max(10_000)
          .describe(
            'Structured ticket summary in the form: Question: ...\nWhat was tried: ...\nDocs searched: ...\nUser context: ...',
          ),
      }),
      execute: async ({ issue }) => {
        if (ticketOpenedInTurn) {
          return {
            ticketId: null,
            status: 'error',
            message: 'A knowledge ticket was already created in this turn.',
          };
        }
        ticketOpenedInTurn = true;
        const ticketLimit = await deps.rateLimit.check(`ticket:${userId}`, { limit: 1, windowMs: 5 * 60_000 });
        if (!ticketLimit.ok) {
          const retryAfterSec = Number.isFinite(ticketLimit.retryAfterMs)
            ? Math.ceil(ticketLimit.retryAfterMs / 1000)
            : undefined;
          return {
            ticketId: null,
            status: 'error',
            message:
              retryAfterSec !== undefined
                ? `Ticket creation is rate limited for this user; retry in about ${retryAfterSec} second${retryAfterSec === 1 ? '' : 's'}.`
                : 'Ticket creation is rate limited for this user.',
          };
        }
        const userProfile = await deps.userResolver(request);
        const realName = userProfile.name ?? 'User';
        const realEmail = userProfile.email ?? `${userId}@clerk.user`;
        const result = await deps.createTicket({
          userId,
          name: realName,
          email: realEmail,
          issue: sanitizeText(issue),
        });
        if (!result.ok) {
          logger.error('createKnowledgeTicket: createTicket failed', { error: result.error });
          return { ticketId: null, status: 'error' };
        }
        metrics.ticketCreated = true;
        metrics.ticketId = result.value.ticketId;
        return result.value;
      },
    }),
  };
}

export async function chatTurn(input: ChatTurnRequest, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const turnStart = input.startedAt ?? performance.now();
  const requestStartedAt = Date.now();
  const expMark = (label: string, extra?: Record<string, unknown>) => {
    const wallMs = Date.now() - requestStartedAt;
    const perfMs = Math.round(performance.now() - turnStart);
    logger.info('[exp-instr] chat-turn phase', { label, wallMs, perfMs, ...extra });
    console.log(`[exp-instr] chat-turn ${label} wallMs=${wallMs} perfMs=${perfMs}`, extra ?? '');
  };
  const { request, userId } = input;
  const cfg = await deps.getRuntimeConfig();
  expMark('config', { retrievalMode: cfg.retrievalMode, prefetchFirstTurn: cfg.prefetchFirstTurn, answerCacheEnabled: cfg.answerCacheEnabled });
  const limit = await deps.rateLimit.check(`chat:${userId}`, CHAT_RATE_LIMIT);
  expMark('rateLimit', { ok: limit.ok });
  if (!limit.ok) {
    return {
      kind: 'rate-limited',
      retryAfterSec: Number.isFinite(limit.retryAfterMs)
        ? String(Math.ceil(limit.retryAfterMs / 1000))
        : undefined,
    };
  }

  const body = await readBoundedJson(request);
  if (body.tooLarge) {
    return { kind: 'payload-too-large' };
  }
  const raw = body.value;
  const parsed = createChatRequestSchema(deps.allowedChatFileOrigins).safeParse(raw);
  expMark('validate', { ok: parsed.success, messages: typeof raw === 'object' && raw !== null ? (raw as { messages?: unknown[] }).messages?.length ?? 0 : 0 });
  if (!parsed.success) {
    return { kind: 'invalid-request', issues: parsed.error.issues };
  }
  const inputMessages: ChatInputMessage[] = parsed.data.messages;
  const messages = toChatUIMessages(inputMessages);
  const lastUserMessage = [...inputMessages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUserMessage
    ? lastUserMessage.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
    : '';

  const groundingEvidence = createGroundingEvidence();
  const capturedCitations = groundingEvidence.citations;

  const turnId = resolveTurnId(parsed.data.turnId);
  const turnRequestHash = {
    current: turnRequestFingerprint({
      conversationId: parsed.data.conversationId,
      retry: parsed.data.retry,
      semanticContext: cacheFingerprint(cfg, cfg.retrievalMode),
      messages: inputMessages,
    }),
    legacy: legacyTurnRequestFingerprint({
      conversationId: parsed.data.conversationId,
      messages: inputMessages,
    }),
  };

  const isFirstTurn = messages.length <= 1;

  const useConfiguredMode = Math.random() * 100 < cfg.retrievalModeRolloutPercent;
  let effectiveMode: 'agentic' | 'normal' = useConfiguredMode
    ? cfg.retrievalMode
    : cfg.retrievalMode === 'agentic'
      ? 'normal'
      : 'agentic';
  if (process.env.AGENTIC_ENABLED === 'false') effectiveMode = 'normal';

  const persistedMode: ChatEventInput['mode'] = effectiveMode === 'normal' ? 'vector' : 'agentic';
  const queryText = cfg.captureQueryText ? lastUserText || null : null;
  const metrics: TurnMetrics = {
    retrieveMs: 0,
    prefetchMs: null,
    prefetchStatus: 'disabled',
    firstTokenMs: null,
    hallucinationMs: null,
    hitCount: null,
    maxSimilarity: null,
    ticketCreated: false,
    ticketId: null,
    rewritten: false,
    reformulationCount: 0,
  };

  const cacheable = cfg.answerCacheEnabled && isFirstTurn && lastUserText.trim() !== '';
  const cacheKey = cacheable
      ? deps.answerCacheKey(lastUserText, {
        embeddingModel: deps.getEmbeddingModelId(),
        chatModel: deps.getChatModelId(),
        userId,
        fingerprint: cacheFingerprint(cfg, effectiveMode),
      })
    : null;
  const turnResultCache = deps.turnResultCache;
  const turnResultKey = turnResultCache && turnId
    ? `rag:turn-result:${encodeURIComponent(userId)}:${turnId}`
    : null;
  let cacheLease: CacheLease | null = null;
  let turnLease: CacheLease | null = null;
  const releaseLeases = async (): Promise<void> => {
    const leases = [cacheLease, turnLease].filter((lease): lease is CacheLease => lease !== null);
    cacheLease = null;
    turnLease = null;
    const results = await Promise.all(leases.map((lease) => lease.releaseResult()));
    for (const result of results) {
      if (result.kind === 'unavailable') {
        logger.warn('chat.cache.lease_release_unavailable', { turnId });
      }
    }
  };
  let leasesEscaped = false;
  const cacheLeaseOptions: CacheLeaseOptions = {
    policy: deps.cacheLeasePolicy ?? 'degraded',
    onTelemetry: deps.onCacheLeaseTelemetry ?? ((event: CacheLeaseTelemetry): void => {
      logger.warn('chat.cache.lease_coordination', {
        operation: event.operation,
        result: event.result,
        policy: event.policy,
      });
    }),
  };

  try {
    if (turnResultCache && turnResultKey) {
      const t0 = performance.now();
      let turnResult = await turnResultCache.get(turnResultKey).catch((e) => { expMark('turnGet-error', { error: String(e) }); return null; });
      expMark('turnGet', { hit: Boolean(turnResult), ms: Math.round(performance.now() - t0), isFirstTurn, cacheable: Boolean(cacheKey) });
      let turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
      if (turnState && 'conflict' in turnState) { expMark('turnConflict'); return { kind: 'idempotency-conflict' }; }
      if (!turnState) {
        const lease = createCacheLease(
          turnResultCache,
          turnResultKey,
          Math.ceil(MAX_DURATION_MS / 1000),
          cacheLeaseOptions,
        );
        const a0 = performance.now();
        const leaseResult = await lease.acquireResult();
        expMark('turnAcquire', { result: leaseResult.kind, ms: Math.round(performance.now() - a0) });
        if (leaseResult.kind === 'acquired') {
          turnLease = lease;
          turnResult = await turnResultCache.get(turnResultKey).catch(() => null);
          turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
          if (turnState && 'conflict' in turnState) { expMark('turnConflict-after-acquire'); return { kind: 'idempotency-conflict' }; }
        } else if (leaseResult.kind === 'held') {
          const remainingWaitMs = Math.max(
            0,
            MAX_DURATION_MS - (Date.now() - requestStartedAt) - 5_000,
          );
          expMark('turnWait-start', { remainingWaitMs });
          const w0 = performance.now();
          turnResult = await waitForCachedAnswer(turnResultCache, turnResultKey, {
            timeoutMs: remainingWaitMs,
            signal: request.signal,
          });
          expMark('turnWait-done', { hit: Boolean(turnResult), ms: Math.round(performance.now() - w0) });
          turnState = turnResult ? parseTurnResult(turnResult, turnRequestHash) : null;
          if (turnState && 'conflict' in turnState) return { kind: 'idempotency-conflict' };
          if (!turnState) { expMark('turnWait-timeout'); return { kind: 'cache-wait-timeout' }; }
        } else {
          expMark('turnUnavailable');
          return { kind: 'cache-unavailable' };
        }
      }
      if (turnState && 'answer' in turnState) {
        const cachedAnswer = turnState.answer;
        deps.eventSink.record({
          turnId,
          userId,
          query: queryText,
          mode: persistedMode,
          cacheHit: true,
          totalMs: Math.round(performance.now() - turnStart),
          ...(cachedAnswer.citations.length > 0
            ? {
                citationCount: cachedAnswer.citations.length,
                meta: buildEventMeta({ documentIds: citationDocumentIds(cachedAnswer.citations) }),
              }
            : {}),
        });
        // EXP-TAIL: do NOT await Neon TX before first byte. Persist in background,
        // return stream immediately to isolate history-TX TTFB cost.
        expMark('turnCacheHit-persistStart', {});
        const persistStart = performance.now();
        void persistHistory(deps.historySink, cfg, userId, {
          conversationId: parsed.data.conversationId,
          turnId,
          retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
          title: lastUserText,
          userMessage: lastUserMessage,
          assistantMessage: buildAssistantMessageLike({
            turnId,
            text: cachedAnswer.text,
            citations: dedupeCitations(cachedAnswer.citations),
            guardrail: cachedAnswer.guardrail ?? null,
          }),
        }).then(
          (ok) => expMark('turnCacheHit-persistDone', { ms: Math.round(performance.now() - persistStart), persisted: ok }),
          (e) => expMark('turnCacheHit-persistError', { ms: Math.round(performance.now() - persistStart), error: String(e) }),
        );
        const historyPersisted = false;
        await releaseLeases();
        const stream = createCachedAnswerStream(
          deps.ai,
          cachedAnswer,
          historyPersisted,
          parsed.data.conversationId,
        );
        leasesEscaped = true;
        return {
          kind: 'stream',
          stream,
          meta: { turnId, mode: persistedMode, cacheHit: true },
        };
      }
    }

    if (cacheKey) {
    if (deps.traceEnabled) logger.info('rag.cache.get', { query: lastUserText, key: cacheKey });
    const c0 = performance.now();
    let cached = await deps.answerCache.get(cacheKey).catch(() => null);
    expMark('answerGet', { hit: Boolean(cached), ms: Math.round(performance.now() - c0) });
    if (!cached) {
      const lease = createCacheLease(
        deps.answerCache,
        cacheKey,
        Math.ceil(MAX_DURATION_MS / 1000),
        cacheLeaseOptions,
      );
      const a0 = performance.now();
      const leaseResult = await lease.acquireResult();
      expMark('answerAcquire', { result: leaseResult.kind, ms: Math.round(performance.now() - a0) });
      if (leaseResult.kind === 'acquired') {
        cacheLease = lease;
        cached = await deps.answerCache.get(cacheKey).catch(() => null);
      } else if (leaseResult.kind === 'held') {
        const remainingWaitMs = Math.max(
          0,
          MAX_DURATION_MS - (Date.now() - requestStartedAt) - 5_000,
        );
        expMark('answerWait-start', { remainingWaitMs });
        const w0 = performance.now();
        cached = await waitForCachedAnswer(deps.answerCache, cacheKey, {
          timeoutMs: remainingWaitMs,
          signal: request.signal,
        });
        expMark('answerWait-done', { hit: Boolean(cached), ms: Math.round(performance.now() - w0) });
        if (!cached) { expMark('answerWait-timeout'); return { kind: 'cache-wait-timeout' }; }
      } else {
        expMark('answerUnavailable');
        return { kind: 'cache-unavailable' };
      }
    }
    if (cached) {
      if (deps.traceEnabled) logger.info('rag.cache.hit', { key: cacheKey });
      const cachedAnswer = parseCachedAnswer(cached);
      deps.eventSink.record({
        turnId,
        userId,
        query: queryText,
        mode: persistedMode,
        cacheHit: true,
        totalMs: Math.round(performance.now() - turnStart),
        ...(cachedAnswer.citations.length > 0
          ? {
              citationCount: cachedAnswer.citations.length,
              meta: buildEventMeta({ documentIds: citationDocumentIds(cachedAnswer.citations) }),
            }
          : {}),
      });
      // EXP-TAIL: same as turn-result path — background persist, immediate stream.
      expMark('answerCacheHit-persistStart', {});
      const answerPersistStart = performance.now();
      void persistHistory(deps.historySink, cfg, userId, {
        conversationId: parsed.data.conversationId,
        turnId,
        retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
        title: lastUserText,
        userMessage: lastUserMessage,
        assistantMessage: buildAssistantMessageLike({
          turnId,
          text: cachedAnswer.text,
          citations: dedupeCitations(cachedAnswer.citations),
          guardrail: null,
        }),
      }).then(
        (ok) => expMark('answerCacheHit-persistDone', { ms: Math.round(performance.now() - answerPersistStart), persisted: ok }),
        (e) => expMark('answerCacheHit-persistError', { ms: Math.round(performance.now() - answerPersistStart), error: String(e) }),
      );
      const historyPersisted = false;
      await releaseLeases();
      const stream = deps.ai.createUIMessageStream<UIMessage>({
        execute: ({ writer }) => {
          writer.write({ type: 'text-start', id: 'cached' });
          writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
          writer.write({ type: 'text-end', id: 'cached' });
          for (const src of dedupeCitations(cachedAnswer.citations)) {
            writer.write({
              type: 'data-citation',
              data: src,
            });
          }
          if (historyPersisted && parsed.data.conversationId) {
            writer.write({
              type: 'data-conversation-persisted',
              data: { conversationId: parsed.data.conversationId },
            });
          }
        },
      });
      leasesEscaped = true;
      return {
        kind: 'stream',
        stream,
        meta: { turnId, mode: persistedMode, cacheHit: true },
      };
    }
    if (deps.traceEnabled) logger.info('rag.cache.miss', { key: cacheKey });
    }

  let prefetch: RetrievedChunk[] | null = null;
  if (cfg.prefetchFirstTurn && isFirstTurn && lastUserText.trim() !== '') {
    const prefetchStartedAt = performance.now();
    expMark('prefetch-start', {});
    const prefetchResult = await deps.searchChunks(cfg, lastUserText, { signal: request.signal });
    metrics.prefetchMs = Math.round(performance.now() - prefetchStartedAt);
    metrics.retrieveMs += metrics.prefetchMs;
    metrics.prefetchStatus = 'performed';
    expMark('prefetch-done', { prefetchMs: metrics.prefetchMs, ok: prefetchResult.ok, hits: prefetchResult.ok ? prefetchResult.value.length : 0 });
    if (!prefetchResult.ok) {
      logger.error('First-turn pre-fetch failed', { error: prefetchResult.error });
      prefetch = null;
    } else {
      prefetch = addGroundingEvidence(groundingEvidence, prefetchResult.value);
    }
  }

  const modelRequestOptions = deps.getChatModelRequestOptions?.({
    stablePromptPrefix: buildStableSystemPrompt(cfg),
    prefixVersion: SYSTEM_PROMPT_PREFIX_VERSION,
  });

  const outOfDomainRef = { value: false };
  const isEmptyRef = { value: false };
  const resultStateRef = { value: null as AgenticResultState | null };

  const rawSoftDeadlineMs = deps.turnSoftDeadlineMs ?? DEFAULT_TURN_SOFT_DEADLINE_MS;
  const maxSoftDeadlineMs = MAX_DURATION_MS - 5_000;
  let softDeadlineMs = rawSoftDeadlineMs;
  if (softDeadlineMs > maxSoftDeadlineMs) {
    logger.warn('CHAT_SOFT_DEADLINE_MS clamped', { requested: rawSoftDeadlineMs, clamped: maxSoftDeadlineMs });
    softDeadlineMs = maxSoftDeadlineMs;
  }
  const judgeMaxWallMs = deps.judgeMaxWallMs ?? DEFAULT_JUDGE_MAX_WALL_MS;
  const elapsedBeforeStream = Date.now() - requestStartedAt;
  expMark('preStream', { elapsedBeforeStream, softDeadlineMs, cacheHit: false, prefetchStatus: metrics.prefetchStatus, prefetchMs: metrics.prefetchMs });
  // An already-expired budget must abort immediately; a one-second floor here
  // would let the model run past the application's hard wall-time boundary.
  const softDeadlineMsRemaining = Math.max(0, softDeadlineMs - elapsedBeforeStream);
  const softDeadlineSignal = AbortSignal.timeout(softDeadlineMsRemaining);
  let softDeadlineFired = false;
  softDeadlineSignal.addEventListener('abort', () => {
    softDeadlineFired = true;
  });

  const result = deps.ai.streamText({
    model: deps.getChatModel(),
    system: buildSystemPrompt(cfg, prefetch),
    messages: await deps.ai.convertToModelMessages(compactModelHistory(messages), {
      ignoreIncompleteToolCalls: true,
    }),
    stopWhen: deps.ai.stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: AbortSignal.any([request.signal, softDeadlineSignal]),
    tools: buildChatTools(deps, {
      cfg,
      effectiveMode,
      userId,
      request,
      groundingEvidence,
      outOfDomainRef,
      isEmptyRef,
      resultStateRef,
      metrics,
      ...(prefetch ? { prefetched: { query: lastUserText, matches: prefetch } } : {}),
    }),
    ...(modelRequestOptions?.providerOptions !== undefined
      ? { providerOptions: modelRequestOptions.providerOptions }
      : {}),
  });

  const llmStream = result.toUIMessageStream<UIMessage>({ originalMessages: messages });

  const citationStream = new ReadableStream<InferUIMessageChunk<UIMessage>>({
    start(controller) {
      const reader = llmStream.getReader();
      (async () => {
        let partialText = '';
        let generationCompletedCleanly = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (metrics.firstTokenMs === null && value.type.startsWith('text')) {
              metrics.firstTokenMs = Math.round(performance.now() - turnStart);
            }
            if (value.type === 'text-delta') {
              partialText += value.delta;
            }
            controller.enqueue(value);
          }
          generationCompletedCleanly = !softDeadlineSignal.aborted;
          const timedOut = softDeadlineFired && !request.signal.aborted && !generationCompletedCleanly;
          if (timedOut) {
            controller.enqueue({
              type: 'data-guardrail',
              data: { outOfDomain: false, notice: true, isEmpty: false, offerTicket: false, message: TURN_DEADLINE_BANNER_MESSAGE },
            });
            const tid = `deadline-${turnId}`;
            controller.enqueue({ type: 'text-start', id: tid });
            controller.enqueue({
              type: 'text-delta',
              id: tid,
              delta: TURN_DEADLINE_TEXT,
            });
            controller.enqueue({ type: 'text-end', id: tid });
          }
          const finalCitations = dedupeCitations(capturedCitations);
          for (const src of finalCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            });
          }
          const hasGroundingEvidence = groundingEvidence.documents.length > 0;
          const finalOutOfDomain = !hasGroundingEvidence && outOfDomainRef.value;
          const hallucinationStart = performance.now();
          const remainingWallMs = MAX_DURATION_MS - (Date.now() - requestStartedAt);
          const hallucinationBudgetMs = Math.min(12_000, Math.max(0, remainingWallMs - 2_000));
          let hallucinationBlocked = false;
          let hallucinationTimedOut = false;
          if (timedOut) {
          } else if (hallucinationBudgetMs <= 0) {
            hallucinationTimedOut = true;
            logger.warn('hallucination check skipped: no wall-time budget', { remainingWallMs });
          } else {
            const hallucinationResult = await runHallucinationCheck({
              controller,
              result,
              groundingDocuments: groundingEvidence.documents,
              hallucinationGrader: deps.hallucinationGrader(cfg),
              enabled: cfg.hallucinationCheckEnabled,
              outOfDomain: finalOutOfDomain,
              timeoutMs: hallucinationBudgetMs,
            });
            hallucinationBlocked = hallucinationResult.blocked;
            hallucinationTimedOut = hallucinationResult.timedOut;
          }
          metrics.hallucinationMs = Math.round(performance.now() - hallucinationStart);
          const isEmpty = !hasGroundingEvidence && (isEmptyRef.value || finalOutOfDomain);
          if (
            cacheKey &&
            cacheLease?.isOwned() === true &&
            !timedOut &&
            shouldCache({
              citations: finalCitations,
              blocked: hallucinationBlocked,
              hallucinationTimedOut,
              isEmpty,
              ticketCreated: metrics.ticketCreated,
              cfg,
            })
          ) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (deps.traceEnabled) {
                  logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                }
                await cacheLease?.publish(
                  JSON.stringify({ v: 1, text: finalAnswer, citations: finalCitations }),
                  cfg.answerCacheTtlSec,
                );
              }
            } catch (err) {
              logger.warn('Answer cache write skipped', { error: String(err) });
            }
          }
          if (turnResultCache && turnResultKey && turnLease?.isOwned() === true && !timedOut) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                const guardrail = hallucinationBlocked
                  ? {
                      outOfDomain: finalOutOfDomain,
                      offerTicket: true,
                      isEmpty,
                    }
                  : undefined;
                await turnLease?.publish(
                  JSON.stringify({
                    v: 1,
                    kind: 'turn-result',
                    requestFingerprint: turnRequestHash.current,
                    fingerprintVersion: TURN_FINGERPRINT_VERSION,
                    text: finalAnswer,
                    citations: finalCitations,
                    ...(guardrail ? { guardrail } : {}),
                  }),
                  TURN_RESULT_CACHE_TTL_SEC,
                );
              }
            } catch (err) {
              logger.warn('Turn result cache write skipped', { error: String(err) });
            }
          }
          const usageCandidate = result.totalUsage !== undefined ? result.totalUsage : result.usage;
          const usageValue = await Promise.resolve(usageCandidate).catch(() => null);
          const parsedUsage = parseGenerationUsage(usageValue);
          let promptCacheUsage: ChatModelUsageTelemetry | null = null;
          if (modelRequestOptions?.parseUsage) {
            try {
              const providerMetadata = result.providerMetadata === undefined
                ? undefined
                : await Promise.resolve(result.providerMetadata).catch(() => undefined);
              promptCacheUsage = modelRequestOptions.parseUsage(usageValue, providerMetadata);
            } catch (cause: unknown) {
              logger.warn('chat.model.prompt_cache_usage_parse_failed', {
                error: String(cause),
              });
            }
          }
          const inputTokens = promptCacheUsage?.inputTokens ?? parsedUsage.inputTokens;
          const outputTokens = parsedUsage.outputTokens;
          const totalMs = Math.round(performance.now() - turnStart);
          deps.eventSink.record({
            turnId,
            userId,
            query: queryText,
            mode: persistedMode,
            retrieveMs: metrics.retrieveMs,
            generateMs: Math.max(0, totalMs - metrics.retrieveMs),
            totalMs,
            hitCount: metrics.hitCount,
            maxSimilarity: metrics.maxSimilarity,
            outOfDomain: finalOutOfDomain,
            hallucinationBlocked,
            ticketCreated: metrics.ticketCreated,
            citationCount: finalCitations.length,
            tokensIn: inputTokens,
            tokensOut: outputTokens,
            meta: buildEventMeta({
              rewritten: metrics.rewritten,
              documentIds: citationDocumentIds(finalCitations),
              ticketId: metrics.ticketCreated ? metrics.ticketId : null,
              isEmpty,
              resultState: timedOut ? undefined : resultStateRef.value ?? undefined,
              modelTelemetry: modelRequestOptions?.telemetry,
              promptCache: promptCacheUsage
                ? {
                    inputTokens: promptCacheUsage.inputTokens,
                    inputTokensStatus: promptCacheUsage.inputTokensStatus,
                    cachedInputTokens: promptCacheUsage.cachedInputTokens,
                    cachedInputTokensStatus: promptCacheUsage.cachedInputTokensStatus,
                    cacheReadTokens: promptCacheUsage.cacheReadTokens,
                    cacheReadStatus: promptCacheUsage.cacheReadStatus,
                    cacheWriteTokens: promptCacheUsage.cacheWriteTokens,
                    cacheWriteStatus: promptCacheUsage.cacheWriteStatus,
                    cacheHitRatio: promptCacheUsage.cacheHitRatio,
                  }
                : undefined,
              prefetchStatus: metrics.prefetchStatus,
              prefetchMs: metrics.prefetchMs,
              reformulationCount: metrics.reformulationCount,
              retrievalProvider: deps.getRetrievalProvider?.() ?? 'unknown',
              retrievalMode: persistedMode,
              ...(timedOut ? { fallbackReason: 'turn_deadline' as const } : {}),
            }),
          });
          logger.info('chat.turn.timings', {
            event: 'chat.turn.timings',
            turnId,
            retrieveMs: metrics.retrieveMs,
            prefetchMs: metrics.prefetchMs,
            prefetchStatus: metrics.prefetchStatus,
            reformulationCount: metrics.reformulationCount,
            retrievalProvider: deps.getRetrievalProvider?.() ?? 'unknown',
            retrievalMode: persistedMode,
            firstTokenMs: metrics.firstTokenMs,
            hallucinationMs: metrics.hallucinationMs,
            generateMs: Math.max(0, totalMs - metrics.retrieveMs),
            totalMs,
          });
          const persistedText = await Promise.resolve(result.text).catch(() => partialText);
          const historyPersisted = await persistHistory(deps.historySink, cfg, userId, {
            conversationId: parsed.data.conversationId,
            turnId,
            retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
            title: lastUserText,
            userMessage: lastUserMessage,
            assistantMessage: buildAssistantMessageLike({
              turnId,
              text: persistedText || partialText,
              citations: finalCitations,
              guardrail: hallucinationBlocked
                ? {
                    outOfDomain: outOfDomainRef.value,
                    offerTicket: true,
                  }
                : timedOut
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      notice: true,
                      message: TURN_DEADLINE_BANNER_MESSAGE,
                    }
                  : null,
            }),
          });
          if (historyPersisted && parsed.data.conversationId) {
            controller.enqueue({
              type: 'data-conversation-persisted',
              data: { conversationId: parsed.data.conversationId },
            });
          }
          if (
            turnId &&
            deps.judgeScheduler &&
            deps.qualityJudge &&
            !timedOut &&
            Math.random() < cfg.judgeSampleRate &&
            finalCitations.length > 0 &&
            !isEmpty &&
            performance.now() - turnStart <= judgeMaxWallMs &&
            cfg.captureQueryText !== false
          ) {
            const answer = await Promise.resolve(result.text).catch(() => partialText);
            const snippets = finalCitations.map((c) => c.snippet);
            const qualityJudge = deps.qualityJudge;
            deps.judgeScheduler(() =>
              qualityJudge({
                question: lastUserText,
                snippets,
                documents: snippets.join('\n\n'),
                answer,
                turnId,
              }),
            );
          }
        } catch (err) {
          logger.error('Chat stream error', { error: err });
          try {
            if (metrics.ticketCreated) {
              logger.warn('chat.turn.ticket_created_but_stream_failed', { turnId, ticketId: metrics.ticketId });
              deps.eventSink.record({
                turnId,
                userId,
                query: queryText,
                mode: persistedMode,
                ticketCreated: true,
                hallucinationBlocked: false,
                citationCount: dedupeCitations(capturedCitations).length,
                meta: buildEventMeta({
                  ticketId: metrics.ticketId,
                  resultState: resultStateRef.value ?? undefined,
                  isEmpty: isEmptyRef.value || outOfDomainRef.value || undefined,
                }),
              });
              if (cfg.captureQueryText && deps.historySink && parsed.data.conversationId) {
                const orphanTurnId = turnId ?? randomUUID();
                void deps.historySink
                  .appendTurn({
                    userId,
                    conversationId: parsed.data.conversationId,
                    turnId: orphanTurnId,
                    title: lastUserText,
                    userMessage: lastUserMessage ?? { role: 'user', parts: [{ type: 'text', text: lastUserText }] },
                    assistantMessage: buildAssistantMessageLike({
                      turnId: orphanTurnId,
                      text: 'ticket_created_but_stream_failed',
                      citations: dedupeCitations(capturedCitations),
                      guardrail: null,
                    }),
                  })
                  .catch((cause: unknown) =>
                    logger.error('chat.turn.orphan_history_failed', {
                      turnId,
                      error: String(cause),
                    }),
                  );
              }
            }
          } catch {}
          await releaseLeases();
          controller.error(new Error('Chat stream interrupted'));
          return;
        }
        await releaseLeases();
        controller.close();
      })();
    },
  });

  leasesEscaped = true;
  return {
    kind: 'stream',
    stream: citationStream,
    meta: { turnId, mode: persistedMode, cacheHit: false },
  };
  } finally {
    if (!leasesEscaped) await releaseLeases();
  }
}

const DEFAULT_TURN_SOFT_DEADLINE_MS = 50_000;
const DEFAULT_JUDGE_MAX_WALL_MS = 20_000;

async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>;
  result: { text: PromiseLike<string> };
  groundingDocuments: string[];
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  enabled: boolean;
  outOfDomain: boolean;
  timeoutMs?: number;
}): Promise<{ blocked: boolean; timedOut: boolean }> {
  const { controller, result, groundingDocuments, hallucinationGrader, enabled, outOfDomain } = opts;
  if (!enabled || !hallucinationGrader) return { blocked: false, timedOut: false };

  if (outOfDomain && groundingDocuments.length === 0) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: true, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
    return { blocked: true, timedOut: false };
  }

  let ungrounded = false;
  let timedOut = false;
  if (groundingDocuments.length > 0) {
    try {
      const generation = await result.text;
      const documents = groundingDocuments.join('\n\n');
      let verdict: 'yes' | 'no';
      if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0) {
        throw Object.assign(new Error('Hallucination verification skipped: no wall-time budget'), { name: 'TimeoutError' });
      } else if (opts.timeoutMs !== undefined && opts.timeoutMs < 12_000) {
        verdict = await Promise.race([
          hallucinationGrader(documents, generation),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error('Hallucination verification timed out'), { name: 'TimeoutError' })), opts.timeoutMs),
          ),
        ]);
      } else {
        verdict = await hallucinationGrader(documents, generation);
      }
      ungrounded = verdict === 'no';
    } catch (err) {
      const isTimeout =
        (err as { name?: string })?.name === 'TimeoutError' ||
        (err as { name?: string })?.name === 'AbortError' ||
        /timed out|budget/i.test(String((err as Error)?.message ?? ''));
      if (isTimeout) timedOut = true;
      logger.error('Hallucination check failed', { error: err });
    }
  }

  if (ungrounded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: false, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
  }
  return { blocked: ungrounded, timedOut };
}
