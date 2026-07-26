import { tool, convertToModelMessages, streamText, stepCountIs, createUIMessageStreamResponse, createUIMessageStream, type InferUIMessageChunk } from 'ai';
import { z } from 'zod';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getComposition, type MyUIMessage, type Composition } from '@/composition';
import type { RetrievedChunk } from '@app/application/rag/search';
import { buildSystemPrompt } from '@app/application/prompt/build-system-prompt';
import { NextResponse, after } from 'next/server';
import type { ChatEventInput } from '@app/domain';
import { ChatRequestSchema } from './request-schema';
import { sanitizeText } from '@/lib/sanitize';
import { logger } from '@/lib/logger';
import { TOOL_CONTENT_CAP, CHAT_RATE_LIMIT, TRACE_ENABLED, CHAT_MAX_BODY_BYTES } from '../../../../config/constants';
import { getRuntimeConfig } from '@/lib/config/runtime';
import { dedupeCitations } from '@/chat/dedupe-citations';
import { emitCitations, citationDocumentIds, type EmittedCitation } from '@/chat/emit-citations';
import { resolveTurnId } from '@/chat/turn-id';
import { buildEventMeta } from '@/chat/build-event-meta';

/** Per-turn metrics accumulated while the tools run. Persisted to chat_events after generation completes. */
interface TurnMetrics {
  retrieveMs: number;
  hitCount: number | null;
  maxSimilarity: number | null;
  ticketCreated: boolean;
  ticketId: string | null;
  rewritten: boolean;
}

function buildChatTools(deps: {
  effectiveMode: 'agentic' | 'normal';
  searchChunks: (query: string, opts: { limit?: number }) => ReturnType<Composition['searchChunks']>;
  agenticSearch: (query: string) => ReturnType<Composition['agenticSearch']>;
  capturedCitations: EmittedCitation[];
  createTicket: Composition['createTicket'];
  userId: string;
  outOfDomainRef: { value: boolean };
  metrics: TurnMetrics;
}) {
  const { effectiveMode, searchChunks: searchFn, agenticSearch: agenticFn, capturedCitations: citationTarget, createTicket: createTicketFn, userId: uid, outOfDomainRef, metrics } = deps;
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
          outOfDomainRef.value = r.value.outOfDomain;
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
        const capped = matches.map((m) => ({
          content:
            m.content.length > TOOL_CONTENT_CAP
              ? m.content.slice(0, TOOL_CONTENT_CAP) + '\u2026'
              : m.content,
          similarity: m.similarity,
          documentTitle: m.title ?? undefined,
          section: m.sectionTitle ?? undefined,
        }));
        for (const citation of emitCitations(matches)) {
          citationTarget.push(citation);
        }
        return capped;
      },
    }),
    createSupportTicket: tool({
      description:
        'Open a support ticket. Invoke this tool when the user\'s issue cannot be resolved via the available documentation content or the user has explicitly asked to open one, file one, escalate, talk to a human, or submit a complaint. When invoking, provide a structured `issue` summary with appropriate context so the reviewer can understand the full situation without reading the transcript: Product / Question / What was tried / Docs searched / User context.',
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
          logger.warn('createSupportTicket: currentUser() returned null after auth() succeeded');
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
          logger.error('createSupportTicket: createTicket failed', { error: result.error });
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

async function streamChatResponse(req: Request): Promise<Response> {
  const turnStart = performance.now();
  const { userId } = await auth();
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > CHAT_MAX_BODY_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }
  const comp = getComposition();
  const cfg = await getRuntimeConfig();
  const limit = await comp.rateLimit(`chat:${userId}`, CHAT_RATE_LIMIT);
  if (!limit.ok) {
    const retryAfter = Number.isFinite(limit.retryAfterMs)
      ? String(Math.ceil(limit.retryAfterMs / 1000))
      : undefined;
    return new Response('Too Many Requests', {
      status: 429,
      ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
    });
  }

  const raw = await req.json().catch((e) => {
    logger.debug('JSON parse failed', { error: String(e) });
    return null;
  });
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
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

  if (lastUserText) {
    void comp.recordQuery(userId, lastUserText).catch(() => {});
  }

  const capturedCitations: EmittedCitation[] = [];

  const turnId = resolveTurnId(parsed.data.turnId);

  const isFirstTurn = messages.length <= 1;

  // Canary rollout: decide once per request whether to honour the configured
  // retrieval mode or its inverse, then thread that single decision through both
  // the tool-selection gate and the step budget.
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
    ? comp.answerCacheKey(lastUserText, {
        embeddingModel: comp.getEmbeddingModelId(),
        chatModel: (comp.getChatModel() as { modelId?: string })?.modelId ?? 'unknown',
      })
    : null;
  if (cacheKey) {
    if (TRACE_ENABLED) logger.info('rag.cache.get', { query: lastUserText, key: cacheKey });
    const cached = await comp.answerCache.get(cacheKey).catch(() => null);
    if (cached) {
      if (TRACE_ENABLED) logger.info('rag.cache.hit', { key: cacheKey });
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'text-start', id: 'cached' });
          writer.write({ type: 'text-delta', id: 'cached', delta: cached });
          writer.write({ type: 'text-end', id: 'cached' });
        },
      });
      comp.chatEventBatcher.record({
        turnId,
        userId,
        query: queryText,
        mode: persistedMode,
        cacheHit: true,
        totalMs: Math.round(performance.now() - turnStart),
      });
      scheduleFlush(comp);
      return createUIMessageStreamResponse({ stream });
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

  const result = streamText({
    model: comp.getChatModel(),
    system: buildSystemPrompt(cfg, prefetch),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(effectiveMode === 'agentic' ? cfg.agentStepBudget : 5),
    abortSignal: req.signal,
    tools: buildChatTools({
      effectiveMode,
      searchChunks: (query, opts) => comp.searchChunks(cfg, query, opts),
      agenticSearch: (query) => comp.agenticSearch(cfg, query),
      capturedCitations,
      createTicket: comp.createTicket,
      userId,
      outOfDomainRef,
      metrics,
    }),
  });

  const llmStream = result.toUIMessageStream({ originalMessages: messages });

  const citationStream = new ReadableStream<InferUIMessageChunk<MyUIMessage>>({
    start(controller) {
      const reader = llmStream.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          for (const src of dedupeCitations(capturedCitations)) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<MyUIMessage>);
          }
          const hallucinationBlocked = await runHallucinationCheck({
            controller,
            result,
            capturedCitations,
            hallucinationGrader: comp.getHallucinationGrader(cfg),
            outOfDomain: outOfDomainRef.value,
          });
          if (cacheKey) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (TRACE_ENABLED) logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                await comp.answerCache.set(cacheKey, finalAnswer, cfg.answerCacheTtlSec);
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
            citationCount: capturedCitations.length,
            tokensIn: usage?.inputTokens ?? 0,
            tokensOut: usage?.outputTokens ?? 0,
            meta: buildEventMeta({
              rewritten: metrics.rewritten,
              documentIds: citationDocumentIds(capturedCitations),
              ticketId: metrics.ticketCreated ? metrics.ticketId : null,
            }),
          });
        } catch (err) {
          logger.error('Chat stream error', { error: err });
          controller.error(err);
          return;
        }
        controller.close();
      })();
    },
  });

  scheduleFlush(comp);
  return createUIMessageStreamResponse({ stream: citationStream });
}

/**
 * Post-generation guardrail: if retrieval was out-of-domain or the grounded-grader
 * flags the answer as not supported, nudge the client toward a support ticket.
 */
async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<MyUIMessage>>;
  result: { text: PromiseLike<string> };
  capturedCitations: EmittedCitation[];
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  outOfDomain: boolean;
}): Promise<boolean> {
  const { controller, result, capturedCitations, hallucinationGrader, outOfDomain } = opts;
  if (!hallucinationGrader) return false;

  let ungrounded = outOfDomain;
  if (!ungrounded && capturedCitations.length > 0) {
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
      data: { outOfDomain, offerTicket: true },
    } as InferUIMessageChunk<MyUIMessage>);
  }
  return ungrounded;
}

export async function POST(req: Request) {
  return streamChatResponse(req);
}
