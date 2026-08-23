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
  type AgenticResultState,
  type AnswerCache,
  type ChatEventInput,
  type RateLimiter,
  type Result,
} from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import { buildSystemPrompt, FALLBACK_BLOCK } from '../prompt/build-system-prompt';
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
    // legacy plain-text cache entry
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
  /** Schedules a deferred task (route injects an `after`-based scheduler; arch forbids next/server here). */
  judgeScheduler?: (task: () => Promise<void>) => void;
  /** §C3 runs both live quality judges and merges judgeScores for the turn. */
  qualityJudge?: (ctx: {
    question: string;
    snippets: string[];
    documents: string;
    answer: string;
    turnId: string;
  }) => Promise<void>;
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
          // §A3 transport refs: carry the agentic outcome out of the tool into
          // post-stream guardrail, cache and analytics decisions.
          outOfDomainRef.value = r.value.outOfDomain;
          isEmptyRef.value = r.value.isEmpty;
          degradedRef.value = r.value.degraded;
          fallbackReasonRef.value = r.value.fallbackReason;
          resultStateRef.value = r.value.resultState;
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
        // §A4: the system prompt is fixed before tools run, so degraded turns
        // receive the fallback instructions through the tool result instead.
        if (effectiveMode === 'agentic' && degradedRef.value) {
          return [{ content: FALLBACK_BLOCK, similarity: -1 }, ...capped];
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
  const effectiveMode = useConfiguredMode
    ? cfg.retrievalMode
    : cfg.retrievalMode === 'agentic'
      ? 'normal'
      : 'agentic';

  const persistedMode: ChatEventInput['mode'] = effectiveMode === 'normal' ? 'vector' : 'agentic';
  const queryText = cfg.captureQueryText ? lastUserText || null : null;
  const metrics: TurnMetrics = { retrieveMs: 0, hitCount: null, maxSimilarity: null, ticketCreated: false, ticketId: null, rewritten: false };

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

  const result = deps.ai.streamText({
    model: deps.getChatModel(),
    system: buildSystemPrompt(cfg, prefetch, degradedRef.value),
    messages: await deps.ai.convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    stopWhen: deps.ai.stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: request.signal,
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
      metrics,
    }),
  });

  const llmStream = result.toUIMessageStream({ originalMessages: messages });

  const citationStream = new ReadableStream<InferUIMessageChunk<UIMessage>>({
    start(controller) {
      const reader = llmStream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          const finalCitations = dedupeCitations(capturedCitations);
          for (const src of finalCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<UIMessage>);
          }
          const hallucinationBlocked = await runHallucinationCheck({
            controller,
            result,
            capturedCitations: finalCitations,
            hallucinationGrader: deps.hallucinationGrader(cfg),
            enabled: cfg.hallucinationCheckEnabled,
            outOfDomain: outOfDomainRef.value,
            degraded: degradedRef.value,
          });
          const isEmpty = isEmptyRef.value || outOfDomainRef.value;
          if (
            cacheKey &&
            shouldCache({
              citations: finalCitations,
              blocked: hallucinationBlocked,
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
              // Quality/agentic fields are only meaningful once agentic retrieval ran.
              ...(resultStateRef.value
                ? {
                    degraded: degradedRef.value,
                    fallbackReason: fallbackReasonRef.value ?? undefined,
                    isEmpty,
                    resultState: resultStateRef.value,
                  }
                : {}),
            }),
          });
          persistHistory(deps.historySink, cfg, userId, {
            conversationId: parsed.data.conversationId,
            turnId,
            retryOfMessageId: lastUserMessage && parsed.data.retry === true ? lastUserMessage.id : undefined,
            title: lastUserText,
            userMessage: lastUserMessage,
            assistantMessage: buildAssistantMessageLike({
              turnId,
              text: await Promise.resolve(result.text).catch(() => ''),
              citations: finalCitations,
              guardrail: hallucinationBlocked
                ? {
                    outOfDomain: outOfDomainRef.value,
                    offerTicket: true,
                    // F11: keep degraded fidelity when a degraded turn was also blocked.
                    ...(degradedRef.value ? { degraded: true, message: DEGRADED_BANNER_MESSAGE } : {}),
                  }
                : degradedRef.value
                  ? {
                      outOfDomain: false,
                      offerTicket: false,
                      degraded: true,
                      message: DEGRADED_BANNER_MESSAGE,
                      isEmpty: false,
                      resultState: resultStateRef.value ?? 'degraded',
                    }
                  : null,
            }),
          });
          // §C3 sampled live quality judge via injected deps (parity with route.ts).
          // The cache-hit branch returns earlier, so !cacheHit holds at this point.
          if (
            turnId &&
            deps.judgeScheduler &&
            deps.qualityJudge &&
            Math.random() < JUDGE_SAMPLE_RATE &&
            finalCitations.length > 0 &&
            !isEmpty &&
            cfg.captureQueryText !== false
          ) {
            const answer = await Promise.resolve(result.text).catch(() => '');
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

/** §A4 exact soft-banner copy for degraded best-effort turns (mirrored in route.ts). */
const DEGRADED_BANNER_MESSAGE = 'Based on best-effort matches (4) — may be incomplete. Please verify.';

/**
 * Post-generation guardrail [§A4/§B3]: skipped entirely when the hallucination
 * toggle is off. A true empty retrieval (0 rows) keeps the blocking wall with a
 * ticket offer; a degraded top-4 fallback first emits a soft yellow banner
 * (no ticket offer) and an explicit not-grounded verdict still blocks. Grader
 * infra failures fail open — they count as pass, only an explicit verdict blocks.
 */
async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<UIMessage>>;
  result: { text: PromiseLike<string> };
  capturedCitations: EmittedCitation[];
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  enabled: boolean;
  outOfDomain: boolean;
  degraded: boolean;
}): Promise<boolean> {
  const { controller, result, capturedCitations, hallucinationGrader, enabled, outOfDomain, degraded } = opts;
  if (!enabled || !hallucinationGrader) return false;

  if (outOfDomain) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: true, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
    return true;
  }

  if (degraded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { degraded: true, isEmpty: false, offerTicket: false, message: DEGRADED_BANNER_MESSAGE },
    } as InferUIMessageChunk<UIMessage>);
  }

  let ungrounded = false;
  if (capturedCitations.length > 0) {
    try {
      const generation = await result.text;
      const documents = capturedCitations.map((c) => c.snippet).join('\n\n');
      ungrounded = (await hallucinationGrader(documents, generation)) === 'no';
    } catch (err) {
      logger.error('Hallucination check failed', { error: err });
    }
  }

  if (ungrounded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: false, offerTicket: true },
    } as InferUIMessageChunk<UIMessage>);
  }
  return ungrounded;
}
