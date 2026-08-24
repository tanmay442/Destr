import type {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  InferUIMessageChunk,
  UIMessage,
} from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { z } from 'zod';
import {
  CHAT_MAX_BODY_BYTES,
  CHAT_RATE_LIMIT,
  JUDGE_SAMPLE_RATE,
  logger,
  sanitizeText,
  TOOL_CONTENT_CAP,
  DEGRADED_BANNER_MESSAGE,
  degradedBannerMessage,
  FALLBACK_CHUNK_COUNT,
  fallbackBlock,
  TURN_DEADLINE_BANNER_MESSAGE,
  TURN_DEADLINE_TEXT,
  type AgenticResultState,
  type AnswerCache,
  type ChatEventInput,
  type RateLimiter,
  type Result,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import { buildSystemPrompt } from '../prompt/build-system-prompt';
import type { AgenticResult } from '../rag/agentic-search';
import type { RetrievedChunk } from '../rag/search';
import { cacheFingerprint } from './cache-key';
import { buildEventMeta } from './build-event-meta';
import { shouldCache } from './should-cache';
import { buildAssistantMessageLike, type MessageLike } from './history';
import { dedupeCitations } from './dedupe-citations';
import { citationDocumentIds, emitCitations, type EmittedCitation } from './emit-citations';
import { ChatRequestSchema } from './request-schema';
import { resolveTurnId } from './turn-id';

interface CachedAnswerPayload {
  text: string;
  citations: EmittedCitation[];
}

function parseCachedAnswer(value: string): CachedAnswerPayload {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as { v?: unknown; text?: unknown; citations?: unknown };
      if (
        candidate.v === 1 &&
        typeof candidate.text === 'string' &&
        Array.isArray(candidate.citations) &&
        candidate.citations.every(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Record<string, unknown>).snippet === 'string',
        )
      ) {
        return { text: candidate.text, citations: candidate.citations as EmittedCitation[] };
      }
    }
  } catch {
  }
  return { text: value, citations: [] };
}

export type AiSdk = {
  streamText: typeof streamText;
  tool: typeof tool;
  stepCountIs: typeof stepCountIs;
  convertToModelMessages: typeof convertToModelMessages;
  createUIMessageStream: typeof createUIMessageStream;
};

export interface ChatTurnDeps {
  ai: AiSdk;
  getChatModel(): LanguageModelV3;
  getChatModelId(): string;
  getEmbeddingModelId(): string;
  getRuntimeConfig(): Promise<AppConfig>;
  searchChunks(
    cfg: AppConfig,
    query: string,
    opts: { limit?: number | undefined },
  ): Promise<Result<RetrievedChunk[]>>;
  agenticSearch(cfg: AppConfig, query: string): Promise<Result<AgenticResult>>;
  hallucinationGrader(
    cfg: AppConfig,
  ): ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  answerCache: AnswerCache;
  answerCacheKey(
    query: string,
    ctx: { embeddingModel: string; chatModel: string; userId?: string; fingerprint?: string },
  ): string;
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
  | { kind: 'payload-too-large' }
  | { kind: 'invalid-request'; issues: z.ZodIssue[] };

/** Best-effort history persistence; never blocks or fails the chat stream. */
export function persistHistory(
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
): void {
  if (!cfg.captureQueryText || !sink || !input.turnId || !input.userMessage) return;
  if (!input.conversationId) {
    logger.debug('chat.history.persist_skipped', { turnId: input.turnId });
    return;
  }
  void sink
    .appendTurn({
      userId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      retryOfMessageId: input.retryOfMessageId,
      title: input.title,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
    })
    .catch(() =>
      logger.warn('chat.history.persist_failed', {
        conversationId: input.conversationId,
        turnId: input.turnId,
      }),
    );
}

async function readBoundedJson(request: Request): Promise<{ value: unknown; tooLarge: boolean }> {
  if (!request.body) return { value: null, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
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
  firstTokenMs: number | null;
  hallucinationMs: number | null;
  hitCount: number | null;
  maxSimilarity: number | null;
  ticketCreated: boolean;
  ticketId: string | null;
  rewritten: boolean;
}

function buildChatTools(deps: ChatTurnDeps, opts: {
  cfg: AppConfig;
  effectiveMode: 'agentic' | 'normal';
  userId: string;
  request: Request;
  capturedCitations: EmittedCitation[];
  outOfDomainRef: { value: boolean };
  isEmptyRef: { value: boolean };
  degradedRef: { value: boolean };
  fallbackReasonRef: { value: string | null };
  resultStateRef: { value: AgenticResultState | null };
  fallbackCountRef: { value: number | null };
  metrics: TurnMetrics;
}) {
  const {
    cfg,
    effectiveMode,
    userId,
    request,
    capturedCitations,
    outOfDomainRef,
    isEmptyRef,
    degradedRef,
    fallbackReasonRef,
    resultStateRef,
    fallbackCountRef,
    metrics,
  } = opts;
  let ticketOpenedInTurn = false;
  return {
    searchDocumentation: deps.ai.tool({
      description:
        "Search the org documentation for chunks relevant to the user's question. Returns an array of { content, similarity, documentTitle, section } objects, ordered by similarity (highest first). Call this tool whenever you need to ground an answer in the official docs. You may call it more than once with a reformulated query if the first call returns nothing useful. Each `content` is capped at 800 characters; the full chunk is still available, but only the top chunks are returned by default. Do NOT call this for non-documentation questions (medical, legal, personal).",
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
        if (effectiveMode === 'agentic') {
          const r = await deps.agenticSearch(cfg, query);
          if (!r.ok) {
            logger.error('Agentic retrieval failed', { error: r.error });
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'agentic', query, ms: performance.now() - t0, hits: r.value.chunks.length });
          }
          outOfDomainRef.value = r.value.outOfDomain;
          isEmptyRef.value = r.value.isEmpty;
          degradedRef.value = r.value.degraded;
          fallbackReasonRef.value = r.value.fallbackReason;
          resultStateRef.value = r.value.resultState;
          fallbackCountRef.value = r.value.chunks.length;
          if (r.value.rewrittenQuery && r.value.rewrittenQuery !== query) metrics.rewritten = true;
          matches = r.value.chunks;
        } else {
          const r = await deps.searchChunks(cfg, query, { limit });
          if (!r.ok) {
            logger.error('RAG retrieval failed', { error: r.error });
            return [];
          }
          if (deps.traceEnabled) {
            logger.info('rag.retrieve', { mode: 'vector', query, ms: performance.now() - t0, hits: r.value.length });
          }
          matches = r.value;
        }
        metrics.retrieveMs += Math.round(performance.now() - t0);
        metrics.hitCount = (metrics.hitCount ?? 0) + matches.length;
        for (const m of matches) {
          if (metrics.maxSimilarity === null || m.similarity > metrics.maxSimilarity) metrics.maxSimilarity = m.similarity;
        }
        const capped = matches.map((m) => {
          const content =
            m.content.length > TOOL_CONTENT_CAP
              ? m.content.slice(0, TOOL_CONTENT_CAP) + '\u2026'
              : m.content;
          return {
            content: `<reference source="${m.source}">\n${content}\n</reference>`,
            similarity: m.similarity,
            documentTitle: m.title ?? undefined,
            section: m.sectionTitle ?? undefined,
          };
        });
        for (const citation of emitCitations(matches)) {
          capturedCitations.push(citation);
        }
        if (effectiveMode === 'agentic' && degradedRef.value) {
          const block = fallbackBlock(matches.length || FALLBACK_CHUNK_COUNT);
          return [{ content: block, similarity: -1 }, ...capped];
        }
        return capped;
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
  const { request, userId } = input;
  const cfg = await deps.getRuntimeConfig();
  const limit = await deps.rateLimit.check(`chat:${userId}`, CHAT_RATE_LIMIT);
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
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'invalid-request', issues: parsed.error.issues };
  }
  const messages = parsed.data.messages as unknown as UIMessage[];
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUserMessage
    ? lastUserMessage.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
    : '';

  const capturedCitations: EmittedCitation[] = [];

  const turnId = resolveTurnId(parsed.data.turnId);

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
  const metrics: TurnMetrics = { retrieveMs: 0, firstTokenMs: null, hallucinationMs: null, hitCount: null, maxSimilarity: null, ticketCreated: false, ticketId: null, rewritten: false };

  const cacheable = cfg.answerCacheEnabled && isFirstTurn && lastUserText.trim() !== '';
  const cacheKey = cacheable
      ? deps.answerCacheKey(lastUserText, {
        embeddingModel: deps.getEmbeddingModelId(),
        chatModel: deps.getChatModelId(),
        userId,
        fingerprint: cacheFingerprint(cfg, effectiveMode),
      })
    : null;
  if (cacheKey) {
    if (deps.traceEnabled) logger.info('rag.cache.get', { query: lastUserText, key: cacheKey });
    const cached = await deps.answerCache.get(cacheKey).catch(() => null);
    if (cached) {
      if (deps.traceEnabled) logger.info('rag.cache.hit', { key: cacheKey });
      const cachedAnswer = parseCachedAnswer(cached);
      const stream = deps.ai.createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'text-start', id: 'cached' });
          writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
          writer.write({ type: 'text-end', id: 'cached' });
          for (const src of dedupeCitations(cachedAnswer.citations)) {
            writer.write({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<UIMessage>);
          }
        },
      });
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
      persistHistory(deps.historySink, cfg, userId, {
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
      });
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
    const prefetchResult = await deps.searchChunks(cfg, lastUserText, {});
    if (!prefetchResult.ok) {
      logger.error('First-turn pre-fetch failed', { error: prefetchResult.error });
      prefetch = null;
    } else {
      prefetch = prefetchResult.value;
      for (const citation of emitCitations(prefetch)) {
        capturedCitations.push(citation);
      }
    }
  }

  const outOfDomainRef = { value: false };
  const isEmptyRef = { value: false };
  const degradedRef = { value: false };
  const fallbackReasonRef = { value: null as string | null };
  const resultStateRef = { value: null as AgenticResultState | null };
  const fallbackCountRef = { value: null as number | null };

  const rawSoftDeadlineMs = deps.turnSoftDeadlineMs ?? DEFAULT_TURN_SOFT_DEADLINE_MS;
  const maxSoftDeadlineMs = MAX_DURATION_MS - 5_000;
  let softDeadlineMs = rawSoftDeadlineMs;
  if (softDeadlineMs > maxSoftDeadlineMs) {
    logger.warn('CHAT_SOFT_DEADLINE_MS clamped', { requested: rawSoftDeadlineMs, clamped: maxSoftDeadlineMs });
    softDeadlineMs = maxSoftDeadlineMs;
  }
  const judgeMaxWallMs = deps.judgeMaxWallMs ?? DEFAULT_JUDGE_MAX_WALL_MS;
  const elapsedBeforeStream = Date.now() - requestStartedAt;
  const softDeadlineMsRemaining = Math.max(1_000, softDeadlineMs - elapsedBeforeStream);
  const softDeadlineSignal = AbortSignal.timeout(softDeadlineMsRemaining);
  let softDeadlineFired = false;
  softDeadlineSignal.addEventListener('abort', () => {
    softDeadlineFired = true;
  });

  const result = deps.ai.streamText({
    model: deps.getChatModel(),
    system: buildSystemPrompt(cfg, prefetch, degradedRef.value),
    messages: await deps.ai.convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    stopWhen: deps.ai.stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: AbortSignal.any([request.signal, softDeadlineSignal]),
    tools: buildChatTools(deps, {
      cfg,
      effectiveMode,
      userId,
      request,
      capturedCitations,
      outOfDomainRef,
      isEmptyRef,
      degradedRef,
      fallbackReasonRef,
      resultStateRef,
      fallbackCountRef,
      metrics,
    }),
  });

  const llmStream = result.toUIMessageStream({ originalMessages: messages });

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
            if (
              metrics.firstTokenMs === null &&
              typeof (value as { type?: unknown }).type === 'string' &&
              String((value as { type?: unknown }).type).startsWith('text')
            ) {
              metrics.firstTokenMs = Math.round(performance.now() - turnStart);
            }
            const vt = (value as { type?: unknown; delta?: unknown }).type;
            if (vt === 'text-delta' && typeof (value as { delta?: unknown }).delta === 'string') {
              partialText += (value as { delta: string }).delta;
            }
            controller.enqueue(value);
          }
          generationCompletedCleanly = !softDeadlineSignal.aborted;
          const timedOut = softDeadlineFired && !request.signal.aborted && !generationCompletedCleanly;
          if (timedOut) {
            controller.enqueue({
              type: 'data-guardrail',
              data: { outOfDomain: false, degraded: true, isEmpty: false, offerTicket: false, message: TURN_DEADLINE_BANNER_MESSAGE },
            } as InferUIMessageChunk<UIMessage>);
            const tid = `deadline-${turnId}`;
            controller.enqueue({ type: 'text-start', id: tid } as InferUIMessageChunk<UIMessage>);
            controller.enqueue({
              type: 'text-delta',
              id: tid,
              delta: TURN_DEADLINE_TEXT,
            } as InferUIMessageChunk<UIMessage>);
            controller.enqueue({ type: 'text-end', id: tid } as InferUIMessageChunk<UIMessage>);
          }
          const finalCitations = dedupeCitations(capturedCitations);
          for (const src of finalCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<UIMessage>);
          }
          const hallucinationStart = performance.now();
          const degradedMessage = degradedRef.value
            ? degradedBannerMessage(fallbackCountRef.value ?? FALLBACK_CHUNK_COUNT)
            : DEGRADED_BANNER_MESSAGE;
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
              capturedCitations: finalCitations,
              hallucinationGrader: deps.hallucinationGrader(cfg),
              enabled: cfg.hallucinationCheckEnabled,
              outOfDomain: outOfDomainRef.value,
              degraded: degradedRef.value,
              degradedMessage,
              timeoutMs: hallucinationBudgetMs,
            });
            hallucinationBlocked = hallucinationResult.blocked;
            hallucinationTimedOut = hallucinationResult.timedOut;
          }
          metrics.hallucinationMs = Math.round(performance.now() - hallucinationStart);
          const isEmpty = isEmptyRef.value || outOfDomainRef.value;
          if (
            cacheKey &&
            !timedOut &&
            shouldCache({
              citations: finalCitations,
              blocked: hallucinationBlocked,
              hallucinationTimedOut,
              isEmpty,
              ticketCreated: metrics.ticketCreated,
              cfg,
              agentic: {
                chunks: [],
                rewrittenQuery: '',
                outOfDomain: outOfDomainRef.value,
                isEmpty: isEmptyRef.value,
                degraded: degradedRef.value,
                fallbackReason: fallbackReasonRef.value as AgenticResult['fallbackReason'],
                resultState: resultStateRef.value ?? 'ok',
              },
            })
          ) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (deps.traceEnabled) {
                  logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                }
                await deps.answerCache.set(
                  cacheKey,
                  JSON.stringify({ v: 1, text: finalAnswer, citations: finalCitations }),
                  cfg.answerCacheTtlSec,
                );
              }
            } catch (err) {
              logger.warn('Answer cache write skipped', { error: String(err) });
            }
          }
          const usage = await Promise.resolve(result.usage).catch(() => null);
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
            outOfDomain: outOfDomainRef.value,
            hallucinationBlocked,
            ticketCreated: metrics.ticketCreated,
            citationCount: finalCitations.length,
            tokensIn: usage?.inputTokens ?? 0,
            tokensOut: usage?.outputTokens ?? 0,
            meta: buildEventMeta({
              rewritten: metrics.rewritten,
              documentIds: citationDocumentIds(finalCitations),
              ticketId: metrics.ticketCreated ? metrics.ticketId : null,
              ...(resultStateRef.value || timedOut
                ? {
                    degraded: degradedRef.value || timedOut,
                    fallbackReason: timedOut ? 'turn_deadline' : fallbackReasonRef.value ?? undefined,
                    isEmpty,
                    resultState: timedOut ? 'degraded' : resultStateRef.value ?? undefined,
                  }
                : {}),
            }),
          });
          logger.info('chat.turn.timings', {
            event: 'chat.turn.timings',
            turnId,
            retrieveMs: metrics.retrieveMs,
            firstTokenMs: metrics.firstTokenMs,
            hallucinationMs: metrics.hallucinationMs,
            generateMs: Math.max(0, totalMs - metrics.retrieveMs),
            totalMs,
          });
          const persistedText = await Promise.resolve(result.text).catch(() => partialText);
          persistHistory(deps.historySink, cfg, userId, {
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
                    ...(degradedRef.value ? { degraded: true, message: degradedMessage } : {}),
                  }
                : timedOut
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      degraded: true,
                      message: TURN_DEADLINE_BANNER_MESSAGE,
                      isEmpty: false,
                      resultState: 'degraded',
                    }
                  : degradedRef.value
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      degraded: true,
                      message: degradedMessage,
                      isEmpty: false,
                      resultState: resultStateRef.value ?? 'degraded',
                    }
                  : null,
            }),
          });
          if (
            turnId &&
            deps.judgeScheduler &&
            deps.qualityJudge &&
            !timedOut &&
            Math.random() < JUDGE_SAMPLE_RATE &&
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
                  degraded: degradedRef.value || undefined,
                  fallbackReason: fallbackReasonRef.value ?? undefined,
                  resultState: resultStateRef.value ?? undefined,
                  isEmpty: isEmptyRef.value || outOfDomainRef.value || undefined,
                }),
              });
            }
          } catch {}
          controller.error(new Error('Chat stream interrupted'));
          return;
        }
        controller.close();
      })();
    },
  });

  return {
    kind: 'stream',
    stream: citationStream,
    meta: { turnId, mode: persistedMode, cacheHit: false },
  };
}

const DEFAULT_TURN_SOFT_DEADLINE_MS = 50_000;
const DEFAULT_JUDGE_MAX_WALL_MS = 20_000;
const MAX_DURATION_MS = 60_000;

async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>;
  result: { text: PromiseLike<string> };
  capturedCitations: EmittedCitation[];
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  enabled: boolean;
  outOfDomain: boolean;
  degraded: boolean;
  degradedMessage?: string;
  timeoutMs?: number;
}): Promise<{ blocked: boolean; timedOut: boolean }> {
  const { controller, result, capturedCitations, hallucinationGrader, enabled, outOfDomain, degraded } = opts;
  const degradedMessage = opts.degradedMessage ?? DEGRADED_BANNER_MESSAGE;
  if (!enabled || !hallucinationGrader) return { blocked: false, timedOut: false };

  if (outOfDomain) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: true, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
    return { blocked: true, timedOut: false };
  }

  if (degraded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: false, degraded: true, isEmpty: false, offerTicket: false, message: degradedMessage },
    } as InferUIMessageChunk<UIMessage>);
  }

  let ungrounded = false;
  let timedOut = false;
  if (capturedCitations.length > 0) {
    try {
      const generation = await result.text;
      const documents = capturedCitations.map((c) => c.snippet).join('\n\n');
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
