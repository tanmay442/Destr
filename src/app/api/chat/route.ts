import { tool, convertToModelMessages, streamText, stepCountIs, createUIMessageStreamResponse, createUIMessageStream, type InferUIMessageChunk } from 'ai';
import { z } from 'zod';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getComposition, appConfig, type MyUIMessage, type Composition } from '@/composition';
import type { RetrievedChunk } from '@app/application/rag/search';
import { buildSystemPrompt } from '@app/application/prompt/build-system-prompt';
import { NextResponse } from 'next/server';
import { ChatRequestSchema } from './request-schema';
import { sanitizeText } from '@/lib/sanitize';
import { logger } from '@/lib/logger';
import { CITATION_SNIPPET_MAX, TOOL_CONTENT_CAP, CHAT_RATE_LIMIT, AGENT_STEP_BUDGET, AGENTIC_ENABLED, ANSWER_CACHE_ENABLED, ANSWER_CACHE_TTL_SEC, TRACE_ENABLED } from '../../../../config/constants';

function emitCitations(
  chunks: RetrievedChunk[],
  snippetMax = CITATION_SNIPPET_MAX,
): Array<{ similarity: number; snippet: string; fileName: string | null; page: number | null; sectionTitle: string | null; source: string | null }> {
  return chunks.map((m) => ({
    similarity: m.similarity,
    snippet:
      m.content.length > snippetMax
        ? m.content.slice(0, snippetMax) + '\u2026'
        : m.content,
    fileName: m.fileName,
    page: m.page,
    sectionTitle: m.sectionTitle,
    source: m.source,
  }));
}

function buildChatTools(deps: {
  searchChunks: Composition['searchChunks'];
  agenticSearch: Composition['agenticSearch'];
  capturedCitations: Array<{ similarity: number; snippet: string; fileName: string | null; page: number | null; sectionTitle: string | null; source: string | null }>;
  createTicket: Composition['createTicket'];
  userId: string;
  /** Set to true by the agentic loop when retrieval found nothing relevant. */
  outOfDomainRef: { value: boolean };
}) {
  const { searchChunks: searchFn, agenticSearch: agenticFn, capturedCitations: citationTarget, createTicket: createTicketFn, userId: uid, outOfDomainRef } = deps;
  return {
    searchDocumentation: tool({
      description:
        "Search the org documentation for chunks relevant to the user's question. Returns an array of { content, similarity } objects, ordered by similarity (highest first). Call this tool whenever you need to ground an answer in the official docs. You may call it more than once with a reformulated query if the first call returns nothing useful. Each `content` is capped at 800 characters; the full chunk is still available, but only the top chunks are returned by default. Do NOT call this for non-documentation questions (medical, legal, personal).",
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
        const t0 = TRACE_ENABLED ? performance.now() : 0;
        if (agenticFn) {
          const r = await agenticFn(query);
          if (!r.ok) {
            logger.error('Agentic retrieval failed', { error: r.error });
            return [];
          }
          if (TRACE_ENABLED) logger.info('rag.retrieve', { mode: 'agentic', query, ms: performance.now() - t0, hits: r.value.chunks.length });
          outOfDomainRef.value = r.value.outOfDomain;
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
        const capped = matches.map((m) => ({
          content:
            m.content.length > TOOL_CONTENT_CAP
              ? m.content.slice(0, TOOL_CONTENT_CAP) + '\u2026'
              : m.content,
          similarity: m.similarity,
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
          .email()
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
        return result.value;
      },
    }),
  };
}

async function streamChatResponse(req: Request): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }
  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  // Body size enforced at framework level (next.config.ts), not a spoofable header.
  const comp = getComposition();
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

  const capturedCitations: Array<{ similarity: number; snippet: string; fileName: string | null; page: number | null; sectionTitle: string | null; source: string | null }> = [];

  const isFirstTurn = messages.length <= 1;

  // Session 10: answer cache. Only first-turn, query-keyed answers are cached —
  // follow-up turns carry conversation state and must not be served stale. The key
  // pins the embedding + chat model ids so a model swap never serves a stale text.
  const cacheable = ANSWER_CACHE_ENABLED && isFirstTurn && lastUserText.trim() !== '';
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
      return createUIMessageStreamResponse({ stream });
    }
    if (TRACE_ENABLED) logger.info('rag.cache.miss', { key: cacheKey });
  }

  let prefetch: RetrievedChunk[] | null = null;
  if (appConfig.prefetchFirstTurn && isFirstTurn && lastUserText.trim() !== '') {
    const prefetchResult = await comp.searchChunks(lastUserText, {});
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
    system: buildSystemPrompt(appConfig, prefetch),
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(AGENTIC_ENABLED ? AGENT_STEP_BUDGET : 5),
    abortSignal: req.signal,
    tools: buildChatTools({
      searchChunks: comp.searchChunks,
      agenticSearch: comp.agenticSearch,
      capturedCitations,
      createTicket: comp.createTicket,
      userId,
      outOfDomainRef,
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
          for (const src of capturedCitations) {
            controller.enqueue({
              type: 'data-citation',
              data: src,
            } as InferUIMessageChunk<MyUIMessage>);
          }
          await runHallucinationCheck({
            controller,
            result,
            capturedCitations,
            hallucinationGrader: comp.hallucinationGrader,
            outOfDomain: outOfDomainRef.value,
          });
          // Session 10: write the freshly-generated first-turn answer to the cache.
          if (cacheKey) {
            try {
              const finalAnswer = await result.text;
              if (finalAnswer && finalAnswer.trim() !== '') {
                if (TRACE_ENABLED) logger.info('rag.cache.set', { key: cacheKey, length: finalAnswer.length });
                await comp.answerCache.set(cacheKey, finalAnswer, ANSWER_CACHE_TTL_SEC);
              }
            } catch (err) {
              logger.warn('Answer cache write skipped', { error: String(err) });
            }
          }
        } catch (err) {
          logger.error('Chat stream error', { error: err });
          controller.error(err);
          return;
        }
        controller.close();
      })();
    },
  });

  return createUIMessageStreamResponse({ stream: citationStream });
}

/**
 * Post-generation guardrail (Session 8, plan step 7): if the agentic loop is on
 * and retrieval was out-of-domain, or the grounded-grader flags the answer as
 * not supported by the docs, nudge the client toward a support ticket. Never
 * blocks or rewrites the streamed answer — it only appends a control hint.
 */
async function runHallucinationCheck(opts: {
  controller: ReadableStreamDefaultController<InferUIMessageChunk<MyUIMessage>>;
  result: { text: PromiseLike<string> };
  capturedCitations: Array<{ similarity: number; snippet: string; fileName: string | null; page: number | null; sectionTitle: string | null; source: string | null }>;
  hallucinationGrader: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  outOfDomain: boolean;
}): Promise<void> {
  const { controller, result, capturedCitations, hallucinationGrader, outOfDomain } = opts;
  if (!hallucinationGrader) return;

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
}

export async function POST(req: Request) {
  return streamChatResponse(req);
}
