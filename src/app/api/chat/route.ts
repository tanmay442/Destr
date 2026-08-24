import { tool, convertToModelMessages, streamText, stepCountIs, createUIMessageStreamResponse, createUIMessageStream, type InferUIMessageChunk } from 'ai';
import { z } from 'zod';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getComposition, assertSameOrigin, type MyUIMessage, type Composition, TRACE_ENABLED } from '@/composition';
import type { RetrievedChunk } from '@app/application/rag/search';
import { buildSystemPrompt } from '@app/application/prompt/build-system-prompt';
import {
  chatTurn,
  cacheFingerprint,
  ChatRequestSchema,
  dedupeCitations,
  emitCitations,
  citationDocumentIds,
  resolveTurnId,
  buildEventMeta,
  persistHistory,
  buildAssistantMessageLike,
  shouldCache,
  type EmittedCitation,
} from '@app/application/chat';
import type { AgenticResult } from '@app/application';
import { NextResponse, after } from 'next/server';
import type { AgenticResultState, ChatEventInput } from '@app/domain';
import { sanitizeText } from '@/lib/sanitize';
import { logger } from '@/lib/logger';
import { readBoundedText, respond } from '@/lib/http';
import {
  CHAT_RATE_LIMIT,
  CHAT_MAX_BODY_BYTES,
  TOOL_CONTENT_CAP,
  JUDGE_SAMPLE_RATE,
  DEGRADED_BANNER_MESSAGE,
  degradedBannerMessage,
  FALLBACK_CHUNK_COUNT,
  fallbackBlock,
  TURN_DEADLINE_BANNER_MESSAGE,
  TURN_DEADLINE_TEXT,
} from '@app/domain';
import { getRuntimeConfig } from '@/lib/config/runtime';
import { judgeFaithfulness, judgeRelevance } from '@/composition';

/** §A2 platform ceiling for this route; the shared rewrite+grading deadline (25s) sits under it. */
export const maxDuration = 60;

/**
 * §T6 soft turn deadline: fires BEFORE the platform ceiling so a slow generation
 * ends with our own graceful parts instead of a hard kill. Env-tunable for tests.
 */
/** §T4 sampled quality judging is skipped once a turn is this old (ms). */
function positiveIntEnv(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const CHAT_MAX_CONCURRENT = 2;
const chatSlotCounts = new Map<string, number>();
const chatSlotOwners = new WeakMap<Request, string>();

function acquireChatSlot(userId: string): boolean {
  const current = chatSlotCounts.get(userId) ?? 0;
  if (current >= CHAT_MAX_CONCURRENT) return false;
  chatSlotCounts.set(userId, current + 1);
  return true;
}

function releaseChatSlot(userId: string): void {
  const current = chatSlotCounts.get(userId) ?? 1;
  if (current <= 1) chatSlotCounts.delete(userId);
  else chatSlotCounts.set(userId, current - 1);
}

function releaseOwnedChatSlot(req: Request, userId: string): void {
  if (chatSlotOwners.get(req) !== userId) return;
  chatSlotOwners.delete(req);
  releaseChatSlot(userId);
}

function releaseSlotWhenStreamEnds<T extends Response>(res: T, release: () => void): T {
  const body = res.body;
  if (!body) {
    release();
    return res;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    release();
  };
  const tracked = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = body.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              controller.enqueue(value);
            } catch {
              finish();
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
          finish();
          controller.close();
        } catch {
          finish();
          try {
            controller.error(new Error('Chat stream interrupted'));
          } catch {
            // already closed or cancelled
          }
        }
      })();
    },
    cancel() {
      finish();
    },
  });
  return new Response(tracked, { status: res.status, statusText: res.statusText, headers: res.headers }) as T;
}
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

function buildChatTools(deps: {
  effectiveMode: 'agentic' | 'normal';
  searchChunks: (query: string, opts: { limit?: number | undefined }) => ReturnType<Composition['searchChunks']>;
  agenticSearch: (query: string) => ReturnType<Composition['agenticSearch']>;
  capturedCitations: EmittedCitation[];
  createTicket: Composition['createTicket'];
  rateLimit: (key: string, opts: { limit: number; windowMs: number }) => ReturnType<Composition['rateLimit']>;
  userId: string;
  outOfDomainRef: { value: boolean };
  isEmptyRef: { value: boolean };
  degradedRef: { value: boolean };
  fallbackReasonRef: { value: string | null };
  resultStateRef: { value: AgenticResultState | null };
  fallbackCountRef?: { value: number | null };
  metrics: TurnMetrics;
}) {
  const {
    effectiveMode,
    searchChunks: searchFn,
    agenticSearch: agenticFn,
    capturedCitations: citationTarget,
    createTicket: createTicketFn,
    rateLimit: rateLimitFn,
    userId: uid,
    outOfDomainRef,
    isEmptyRef,
    degradedRef,
    fallbackReasonRef,
    resultStateRef,
    metrics,
  } = deps;
  const fallbackCountRef = deps.fallbackCountRef;
  let ticketOpenedInTurn = false;
  return {
    searchDocumentation: tool({
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
          const r = await agenticFn(query);
          if (!r.ok) {
            logger.error('Agentic retrieval failed', { error: r.error });
            return [];
          }
          if (TRACE_ENABLED) logger.info('rag.retrieve', { mode: 'agentic', query, ms: performance.now() - t0, hits: r.value.chunks.length });
          // §A3 transport refs: carry the agentic outcome out of the tool into
          // post-stream guardrail, cache and analytics decisions.
          outOfDomainRef.value = r.value.outOfDomain;
          isEmptyRef.value = r.value.isEmpty;
          degradedRef.value = r.value.degraded;
          fallbackReasonRef.value = r.value.fallbackReason;
          resultStateRef.value = r.value.resultState;
          if (fallbackCountRef) fallbackCountRef.value = r.value.chunks.length;
          if (r.value.rewrittenQuery && r.value.rewrittenQuery !== query) metrics.rewritten = true;
          matches = r.value.chunks;
        } else {
          const r = await searchFn(query, { limit });
          if (!r.ok) {
            logger.error('RAG retrieval failed', { error: r.error });
            return [];
          }
          if (TRACE_ENABLED) logger.info('rag.retrieve', { mode: 'vector', query, ms: performance.now() - t0, hits: r.value.length });
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
          citationTarget.push(citation);
        }
        // §A4: the system prompt is fixed before tools run, so degraded turns
        // receive the fallback instructions through the tool result instead.
        if (effectiveMode === 'agentic' && degradedRef.value) {
          const block = fallbackBlock(matches.length || FALLBACK_CHUNK_COUNT);
          return [{ content: block, similarity: -1 }, ...capped];
        }
        return capped;
      },
    }),
    createKnowledgeTicket: tool({
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
        const ticketLimit = await rateLimitFn(`ticket:${uid}`, { limit: 1, windowMs: 5 * 60_000 });
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
        const clerkUser = await currentUser();
        let realName: string;
        let realEmail: string;
        if (clerkUser) {
          realName =
            clerkUser.fullName ??
            clerkUser.firstName ??
            clerkUser.username ??
            'User';
          const primaryEmail = clerkUser.emailAddresses[0]?.emailAddress;
          realEmail = primaryEmail && primaryEmail.includes('@')
            ? primaryEmail
            : `${clerkUser.id}@clerk.user`;
        } else {
          logger.warn('createKnowledgeTicket: currentUser() returned null after auth() succeeded');
          realName = 'Unknown';
          realEmail = `${uid}@clerk.user`;
        }
        const result = await createTicketFn({
          userId: uid,
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

function scheduleFlush(comp: Composition): void {
  try {
    after(() => {
      void comp.chatEventBatcher.flush();
    });
  } catch {
    void comp.chatEventBatcher.flush();
  }
}

/** Structural §C3 contracts for patching a turn's persisted/buffered event meta. */
interface EventMetaPatcher {
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}
interface BatcherMetaPatcher {
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
}

/**
 * Resolve the §C3 meta-patchers structurally off the chat-event batcher:
 * `updateEventMeta` patches already-flushed rows, `patchMeta` patches events
 * still buffered pre-flush. Either may be absent while the storage layer is
 * mid-rollout; the judge then runs but does not persist.
 */
function getMetaPatchers(comp: Composition): {
  eventMeta: EventMetaPatcher | null;
  batcher: BatcherMetaPatcher | null;
} {
  const candidate = comp.chatEventBatcher as unknown as Partial<EventMetaPatcher & BatcherMetaPatcher>;
  return {
    eventMeta:
      typeof candidate.updateEventMeta === 'function'
        ? { updateEventMeta: candidate.updateEventMeta.bind(candidate) }
        : null,
    batcher:
      typeof candidate.patchMeta === 'function'
        ? { patchMeta: candidate.patchMeta.bind(candidate) }
        : null,
  };
}

/**
 * §C3 live quality judge: score retrieval relevance + answer faithfulness on
 * the cheap grade model and merge `judgeScores` into the turn's event meta.
 * Strictly fire-and-forget — every failure is logged under
 * `judge.enqueue.failed` and never affects the stream. A missing verdict keeps
 * that dimension unjudged (zeros would poison the quality averages).
 */
async function runJudge(ctx: {
  question: string;
  snippets: string[];
  documents: string;
  answer: string;
  turnId: string;
  eventMetaPatcher: EventMetaPatcher | null;
  batcherPatcher: BatcherMetaPatcher | null;
}): Promise<void> {
  try {
    const [relevance, faithfulness] = await Promise.all([
      judgeRelevance(ctx.question, ctx.snippets),
      judgeFaithfulness(ctx.documents, ctx.answer),
    ]);
    if (!relevance && !faithfulness) return;
    const judgeScores: Record<string, unknown> = { judgedAt: new Date().toISOString() };
    if (relevance) judgeScores.retrievalRelevance = relevance.score;
    if (faithfulness) {
      judgeScores.faithfulness = faithfulness.score;
      // EVAL-L3: keep score even when citationPrecision missing (null ⇒ omit that dimension).
      if (faithfulness.citationPrecision !== null) judgeScores.citationPrecision = faithfulness.citationPrecision;
    }
    const patch = { judgeScores };
    // Buffered-first so scores land even when the flush has not happened yet.
    const buffered = ctx.batcherPatcher ? ctx.batcherPatcher.patchMeta(ctx.turnId, patch) : false;
    if (buffered) return;
    const persisted = ctx.eventMetaPatcher
      ? await ctx.eventMetaPatcher.updateEventMeta(ctx.turnId, patch)
      : false;
    if (!persisted) {
      // The event may flush between both attempts; retry once before giving up.
      const retry = () =>
        void ctx.eventMetaPatcher?.updateEventMeta(ctx.turnId, patch).catch((err) => {
          logger.warn('judge.enqueue.meta_retry_failed', { turnId: ctx.turnId, error: String(err) });
        });
      const t = setTimeout(retry, 5_000);
      if (typeof t.unref === 'function') t.unref();
      logger.debug('judge.enqueue.meta_retry_scheduled', { turnId: ctx.turnId });
    }
  } catch (err) {
    logger.warn('quality judge failed', {
      severity: 'warn',
      event: 'judge.enqueue.failed',
      turnId: ctx.turnId,
      error: String(err),
    });
  }
}

/** Deferred task scheduling via Vercel `after`; inline fallback outside request scope. */
function scheduleAfter(task: () => void): void {
  try {
    after(() => task());
  } catch {
    task();
  }
}

/**
 * Post-generation guardrail [§A4/§B3]: skipped entirely when the hallucination
 * toggle is off. A true empty retrieval (0 rows) keeps the blocking wall with a
 * ticket offer; a degraded top-4 fallback first emits a soft yellow banner
 * (no ticket offer) and an explicit not-grounded verdict still blocks. Grader
 * infra failures fail open — they count as pass, only an explicit verdict blocks.
 * CHAT-M2 caching policy: timeout/infra → fail-open but NOT cached (unverified).
 * CHAT-M4: caller may pass timeoutMs bounded by remaining wall time.
 */
async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<MyUIMessage>>;
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
    } as InferUIMessageChunk<MyUIMessage>);
    return { blocked: true, timedOut: false };
  }

  if (degraded) {
    controller.enqueue({
      type: 'data-guardrail',
      data: { outOfDomain: false, degraded: true, isEmpty: false, offerTicket: false, message: degradedMessage },
    } as InferUIMessageChunk<MyUIMessage>);
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
      // CHAT-M2 caching policy: timeout (including wall-budget exhaustion) is unverified → fail-open but NOT cached.
      // Generic infra errors (e.g. grade model down) are also fail-open; we treat only Timeout/Abort as timedOut to preserve
      // existing cached-on-infra-failure contract (tests expect cached). If strict not-cache-on-any-error is desired,
      // change to `timedOut = true` for all errors — this documents the decision per audit's "Decide and document".
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
    } as InferUIMessageChunk<MyUIMessage>);
  }
  return { blocked: ungrounded, timedOut };
}

async function streamChatResponse(req: Request): Promise<Response> {
  const turnStart = performance.now();
  // CHAT-M3: anchor soft deadline at request start, not streamText creation — preamble (auth, cache GET, prefetch) is already elapsed.
  const requestStartedAt = Date.now();
  const { userId } = await auth();
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!acquireChatSlot(userId)) {
    return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '1' } });
  }
  chatSlotOwners.set(req, userId);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseOwnedChatSlot(req, userId);
  };
  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    release();
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  const bounded = await readBoundedText(req, CHAT_MAX_BODY_BYTES);
  if (!bounded.ok) {
    release();
    return bounded.reason === 'too-large'
      ? new Response('Payload too large', { status: 413 })
      : new Response('Bad Request', { status: 400 });
  }
  const comp = getComposition();
  const cfg = await getRuntimeConfig();
  const limit = await comp.rateLimit(`chat:${userId}`, CHAT_RATE_LIMIT);
  if (!limit.ok) {
    release();
    const retryAfter = Number.isFinite(limit.retryAfterMs)
      ? String(Math.ceil(limit.retryAfterMs / 1000))
      : undefined;
    return new Response('Too Many Requests', {
      status: 429,
      ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
    });
  }

  let raw: unknown = null;
  try {
    raw = JSON.parse(bounded.text);
  } catch (e) {
    logger.debug('JSON parse failed', { error: String(e) });
  }
  if (raw !== null && JSON.stringify(raw).length > CHAT_MAX_BODY_BYTES) {
    release();
    return new Response('Payload too large', { status: 413 });
  }
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    release();
    return NextResponse.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
  }
  const messages = parsed.data.messages as unknown as MyUIMessage[];
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUserMessage
    ? lastUserMessage.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
    : '';

  const historySink = {
    appendTurn: async (input: Parameters<typeof comp.appendChatTurn>[0]) => {
      const result = await comp.appendChatTurn(input);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };

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
    ? comp.answerCacheKey(lastUserText, {
        embeddingModel: comp.getEmbeddingModelId(),
        chatModel: (comp.getChatModel() as { modelId?: string })?.modelId ?? 'unknown',
        userId,
        fingerprint: cacheFingerprint(cfg, effectiveMode),
      })
    : null;
  if (cacheKey) {
    if (TRACE_ENABLED) logger.info('rag.cache.get', { query: lastUserText, key: cacheKey });
    const cached = await comp.answerCache.get(cacheKey).catch(() => null);
    if (cached) {
      if (TRACE_ENABLED) logger.info('rag.cache.hit', { key: cacheKey });
      const cachedAnswer = parseCachedAnswer(cached);
      const stream = createUIMessageStream<MyUIMessage>({
        execute: ({ writer }) => {
          writer.write({ type: 'text-start', id: 'cached' });
          writer.write({ type: 'text-delta', id: 'cached', delta: cachedAnswer.text });
          writer.write({ type: 'text-end', id: 'cached' });
          for (const src of dedupeCitations(cachedAnswer.citations)) {
            writer.write({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<MyUIMessage>);
          }
        },
      });
      comp.chatEventBatcher.record({
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
      persistHistory(historySink, cfg, userId, {
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
      scheduleFlush(comp);
      return releaseSlotWhenStreamEnds(createUIMessageStreamResponse({ stream }), release);
    }
    if (TRACE_ENABLED) logger.info('rag.cache.miss', { key: cacheKey });
  }

  let prefetch: RetrievedChunk[] | null = null;
  if (cfg.prefetchFirstTurn && isFirstTurn && lastUserText.trim() !== '') {
    const prefetchResult = await comp.searchChunks(cfg, lastUserText, {});
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

  // §T6 soft deadline: aborts generation just before the platform ceiling so the
  // stream can end with our own graceful parts (see pump below) instead of a kill.
  // CHAT-M3: anchored at requestStartedAt; preamble elapsed is subtracted so total wall time stays under maxDuration.
  // CHAT-L5: clamp absurd env values to [1s, maxDuration-5s] with warning.
  const rawSoftDeadlineMs = positiveIntEnv('CHAT_SOFT_DEADLINE_MS') ?? 50_000;
  const maxSoftDeadlineMs = maxDuration * 1000 - 5_000;
  let turnSoftDeadlineMs = rawSoftDeadlineMs;
  if (turnSoftDeadlineMs > maxSoftDeadlineMs) {
    logger.warn('CHAT_SOFT_DEADLINE_MS clamped', { requested: rawSoftDeadlineMs, clamped: maxSoftDeadlineMs });
    turnSoftDeadlineMs = maxSoftDeadlineMs;
  }
  const judgeMaxWallMs = positiveIntEnv('CHAT_JUDGE_MAX_WALL_MS') ?? 20_000;
  const elapsedBeforeStream = Date.now() - requestStartedAt;
  const turnSoftDeadlineMsRemaining = Math.max(1_000, turnSoftDeadlineMs - elapsedBeforeStream);
  const softDeadlineSignal = AbortSignal.timeout(turnSoftDeadlineMsRemaining);
  let softDeadlineFired = false;
  softDeadlineSignal.addEventListener('abort', () => {
    softDeadlineFired = true;
  });

  const result = streamText({
    model: comp.getChatModel(),
    // CHAT-L7: degradedRef.value is always false here — system prompt is fixed before tools run; degraded fallback is delivered via tool-result injection.
    system: buildSystemPrompt(cfg, prefetch, degradedRef.value),
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    stopWhen: stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: AbortSignal.any([req.signal, softDeadlineSignal]),
    tools: buildChatTools({
      effectiveMode,
      searchChunks: (query, opts) => comp.searchChunks(cfg, query, opts),
      agenticSearch: (query) => comp.agenticSearch(cfg, query),
      capturedCitations,
      createTicket: comp.createTicket,
      rateLimit: (key, opts) => comp.rateLimit(key, opts),
      userId,
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

  const citationStream = new ReadableStream<InferUIMessageChunk<MyUIMessage>>({
    start(controller) {
      const reader = llmStream.getReader();
      (async () => {
        // CHAT-M1: buffer partial streamed text so a soft-deadline abort can still persist what was already shown.
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
            // CHAT-M1: accumulate text-delta parts for fallback if result.text rejects.
            const vt = (value as { type?: unknown; delta?: unknown }).type;
            if (vt === 'text-delta' && typeof (value as { delta?: unknown }).delta === 'string') {
              partialText += (value as { delta: string }).delta;
            }
            controller.enqueue(value);
          }
          // CHAT-M5: race fix — if stream ended cleanly before the deadline fired, don't mark degraded.
          generationCompletedCleanly = !softDeadlineSignal.aborted;
          // §T6 graceful ending: the soft deadline aborted generation — close the
          // stream ourselves with a styled notice instead of leaving a dead pipe.
          const timedOut = softDeadlineFired && !req.signal.aborted && !generationCompletedCleanly;
          if (timedOut) {
            controller.enqueue({
              type: 'data-guardrail',
              data: { outOfDomain: false, degraded: true, isEmpty: false, offerTicket: false, message: TURN_DEADLINE_BANNER_MESSAGE },
            } as InferUIMessageChunk<MyUIMessage>);
            const tid = `deadline-${turnId}`;
            controller.enqueue({ type: 'text-start', id: tid } as InferUIMessageChunk<MyUIMessage>);
            controller.enqueue({
              type: 'text-delta',
              id: tid,
              delta: TURN_DEADLINE_TEXT,
            } as InferUIMessageChunk<MyUIMessage>);
            controller.enqueue({ type: 'text-end', id: tid } as InferUIMessageChunk<MyUIMessage>);
          }
          const finalCitations = dedupeCitations(capturedCitations);
          for (const src of finalCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<MyUIMessage>);
          }
          const degradedMessage = degradedRef.value
            ? degradedBannerMessage(fallbackCountRef.value ?? FALLBACK_CHUNK_COUNT)
            : DEGRADED_BANNER_MESSAGE;
          const hallucinationStart = performance.now();
          // CHAT-M4: bound verification by remaining wall time (reserve 2s for flush/persist). If no budget, treat as timedOut (M2 → not cached).
          const maxDurationMs = maxDuration * 1000;
          const remainingWallMs = maxDurationMs - (Date.now() - requestStartedAt);
          const hallucinationBudgetMs = Math.min(12_000, Math.max(0, remainingWallMs - 2_000));
          let hallucinationBlocked = false;
          let hallucinationTimedOut = false;
          if (timedOut) {
            // soft-deadline already timed out — skip verification
          } else if (hallucinationBudgetMs <= 0) {
            hallucinationTimedOut = true;
            logger.warn('hallucination check skipped: no wall-time budget', { remainingWallMs });
          } else {
            const hallucinationResult = await runHallucinationCheck({
              controller,
              result,
              capturedCitations: finalCitations,
              hallucinationGrader: comp.getHallucinationGrader(cfg),
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
                if (TRACE_ENABLED) logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                await comp.answerCache.set(
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
          comp.chatEventBatcher.record({
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
              // Quality/agentic fields are meaningful once agentic retrieval ran;
              // a soft-deadline turn records its own degraded shape (§T6).
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
          // CHAT-M1: on soft-deadline result.text rejects — persist the partial text already streamed instead of empty.
          const persistedText = await Promise.resolve(result.text).catch(() => partialText);
          persistHistory(historySink, cfg, userId, {
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
                    // F11: keep degraded fidelity when a degraded turn was also blocked.
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
          // §C3 sampled live quality judge — strictly fire-and-forget. The cache-hit
          // short-circuit above returns before this point, so !cacheHit holds here.
          // EVAL-M3 bias/cost note: sampling excludes cache-hits, isEmpty (0 rows), and
          // wall-time > judgeMaxWallMs (20s) turns plus requires citations — so persisted
          // judgeScores over-represent fast, non-cached, citation-bearing turns (survivorship
          // bias for the dashboard). No daily max-samples ceiling yet; if volume grows
          // add a counter check (e.g., skip when today's judged count >500) to bound cost.
          // The 5% JUDGE_SAMPLE_RATE is the current cost ceiling (expected ~1 judge per 20 turns).
          if (
            turnId &&
            !timedOut &&
            Math.random() < JUDGE_SAMPLE_RATE &&
            finalCitations.length > 0 &&
            !isEmpty &&
            performance.now() - turnStart <= judgeMaxWallMs &&
            cfg.captureQueryText !== false
          ) {
            const patchers = getMetaPatchers(comp);
            const answer = await Promise.resolve(result.text).catch(() => partialText);
            const snippets = finalCitations.map((c) => c.snippet);
            scheduleAfter(() =>
              void runJudge({
                question: lastUserText,
                snippets,
                documents: snippets.join('\n\n'),
                answer,
                turnId,
                eventMetaPatcher: patchers.eventMeta,
                batcherPatcher: patchers.batcher,
              }),
            );
          }
        } catch (err) {
          logger.error('Chat stream error', { error: err });
          // CHAT-L8: preserve ticket telemetry even when stream fails before normal event/history persistence.
          try {
            if (metrics.ticketCreated) {
              logger.warn('chat.turn.ticket_created_but_stream_failed', { turnId, ticketId: metrics.ticketId });
              // Best-effort event so analytics still sees ticketCreated.
              comp.chatEventBatcher.record({
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

  scheduleFlush(comp);
  return releaseSlotWhenStreamEnds(createUIMessageStreamResponse({ stream: citationStream }), release);
}

async function streamChatResponseUseCase(req: Request): Promise<Response> {
  const turnStart = performance.now();
  const turnSoftDeadlineMs = positiveIntEnv('CHAT_SOFT_DEADLINE_MS') ?? 50_000;
  const judgeMaxWallMs = positiveIntEnv('CHAT_JUDGE_MAX_WALL_MS') ?? 20_000;
  const { userId } = await auth();
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!acquireChatSlot(userId)) {
    return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '1' } });
  }
  chatSlotOwners.set(req, userId);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseOwnedChatSlot(req, userId);
  };
  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    release();
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  const bounded = await readBoundedText(req, CHAT_MAX_BODY_BYTES);
  if (!bounded.ok) {
    release();
    return bounded.reason === 'too-large'
      ? new Response('Payload too large', { status: 413 })
      : new Response('Bad Request', { status: 400 });
  }
  const boundedReq = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: bounded.text,
    signal: req.signal,
  });
  const comp = getComposition();
  const result = await chatTurn(
    { request: boundedReq, userId, startedAt: turnStart },
    {
      ai: { streamText, tool, stepCountIs, convertToModelMessages, createUIMessageStream },
      getChatModel: () => comp.getChatModel(),
      getChatModelId: () => (comp.getChatModel() as { modelId?: string })?.modelId ?? 'unknown',
      getEmbeddingModelId: () => comp.getEmbeddingModelId(),
      getRuntimeConfig,
      searchChunks: (cfg, query, opts) => comp.searchChunks(cfg, query, opts),
      agenticSearch: (cfg, query) => comp.agenticSearch(cfg, query),
      hallucinationGrader: (cfg) => comp.getHallucinationGrader(cfg),
      answerCache: comp.answerCache,
      answerCacheKey: (query, ctx) => comp.answerCacheKey(query, ctx),
      rateLimit: { check: (key, opts) => comp.rateLimit(key, opts) },
      createTicket: (input) => comp.createTicket(input),
      userResolver: async () => {
        const clerkUser = await currentUser();
        if (!clerkUser) {
          logger.warn('createKnowledgeTicket: currentUser() returned null after auth() succeeded');
          return { userId, name: 'Unknown', email: `${userId}@clerk.user` };
        }
        const name = clerkUser.fullName ?? clerkUser.firstName ?? clerkUser.username ?? 'User';
        const primaryEmail = clerkUser.emailAddresses[0]?.emailAddress;
        const email =
          primaryEmail && primaryEmail.includes('@')
            ? primaryEmail
            : `${clerkUser.id}@clerk.user`;
        return { userId, name, email };
      },
      eventSink: {
        record: (event) => comp.chatEventBatcher.record(event),
        flush: () => comp.chatEventBatcher.flush(),
      },
      historySink: {
        appendTurn: async (input) => {
          const result = await comp.appendChatTurn(input);
          if (!result.ok) throw result.error;
          return result.value;
        },
      },
      // §C3 parity: the use-case path gets the same sampled judge via injected
      // deps (chat-turn itself must not import next/server or infrastructure).
      judgeScheduler: (task) => scheduleAfter(() => void task()),
      turnSoftDeadlineMs: turnSoftDeadlineMs,
      judgeMaxWallMs: judgeMaxWallMs,
      qualityJudge: (ctx) => {
        const patchers = getMetaPatchers(comp);
        return runJudge({
          ...ctx,
          eventMetaPatcher: patchers.eventMeta,
          batcherPatcher: patchers.batcher,
        });
      },
      traceEnabled: TRACE_ENABLED,
    },
  );
  switch (result.kind) {
    case 'rate-limited':
      release();
      return new Response('Too Many Requests', {
        status: 429,
        ...(result.retryAfterSec ? { headers: { 'Retry-After': result.retryAfterSec } } : {}),
      });
    case 'payload-too-large':
      release();
      return new Response('Payload too large', { status: 413 });
    case 'invalid-request':
      release();
      return NextResponse.json({ error: 'invalid_request', issues: result.issues }, { status: 400 });
    case 'stream':
      scheduleFlush(comp);
      return releaseSlotWhenStreamEnds(createUIMessageStreamResponse({ stream: result.stream }), release);
  }
}

export async function POST(req: Request) {
  try {
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;
    if (process.env.CHAT_TURN_USE_CASE === '1') {
      return streamChatResponseUseCase(req);
    }
    return streamChatResponse(req);
  } catch (error) {
    const userId = chatSlotOwners.get(req);
    if (userId) releaseOwnedChatSlot(req, userId);
    logger.error('Chat request failed', { error: String(error) });
    return respond(error);
  }
}
