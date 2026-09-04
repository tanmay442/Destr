import { auth, currentUser } from '@clerk/nextjs/server';
import { getComposition, TRACE_ENABLED } from '@/composition';
import { chatTurn } from '@app/application/chat';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { readBoundedText } from '@/lib/http';
import { CHAT_MAX_BODY_BYTES } from '@app/domain';
import { getRuntimeConfig } from '@/lib/config/runtime';
import { normalizeRateLimitDecision } from './rate-limit';
import { acquireChatSlot, chatSlotOwners, positiveIntEnv, releaseOwnedChatSlot, releaseSlotWhenStreamEnds } from './slots';
import { getMetaPatchers, runJudge, scheduleAfter, scheduleFlush } from './judge';

export async function streamChatResponseUseCase(req: Request): Promise<Response> {
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
    if (bounded.reason === 'too-large') return new Response('Payload too large', { status: 413 });
    if (bounded.reason === 'aborted') return new Response(null, { status: 499 });
    return new Response('Bad Request', { status: 400 });
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
      ai: {
        streamText: comp.modelGateway.streamText,
        tool: comp.modelGateway.tool,
        stepCountIs: comp.modelGateway.stepCountIs,
        convertToModelMessages: comp.modelGateway.convertToModelMessages,
        createUIMessageStream: comp.modelGateway.createUIMessageStream,
      },
      getChatModel: () => comp.getChatModel(),
      getChatModelId: () => (comp.getChatModel() as { modelId?: string })?.modelId ?? 'unknown',
      ...(typeof comp.getChatModelRequestOptions === 'function'
        ? { getChatModelRequestOptions: comp.getChatModelRequestOptions }
        : {}),
      ...(typeof comp.getRetrievalProvider === 'function'
        ? { getRetrievalProvider: comp.getRetrievalProvider }
        : {}),
      getEmbeddingModelId: () => comp.getEmbeddingModelId(),
      getRuntimeConfig,
      searchChunks: (cfg, query, opts) => comp.searchChunks(cfg, query, opts),
      agenticSearch: (cfg, query, opts) => comp.agenticSearch(cfg, query, opts),
      hallucinationGrader: (cfg) => comp.getHallucinationGrader(cfg),
      answerCache: comp.answerCache,
      turnResultCache: comp.turnResultCache,
      answerCacheKey: (query, ctx) => comp.answerCacheKey(query, ctx),
      cacheLeasePolicy: comp.cacheLeasePolicy,
      onCacheLeaseTelemetry: comp.onCacheLeaseTelemetry,
      rateLimit: {
        check: async (key, opts) => normalizeRateLimitDecision(await comp.rateLimit(key, opts)),
      },
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
    case 'cache-wait-timeout':
      release();
      return new Response('The answer is still being generated. Please retry shortly.', {
        status: 503,
        headers: { 'Retry-After': '1' },
      });
    case 'cache-unavailable':
      release();
      return new Response('Chat coordination is temporarily unavailable. Please retry shortly.', {
        status: 503,
        headers: { 'Retry-After': '1' },
      });
    case 'idempotency-conflict':
      release();
      return new Response('The turn ID is already associated with a different request.', { status: 409 });
    case 'payload-too-large':
      release();
      return new Response('Payload too large', { status: 413 });
    case 'invalid-request':
      release();
      return NextResponse.json({ error: 'invalid_request', issues: result.issues }, { status: 400 });
    case 'stream':
      scheduleFlush(comp);
      return releaseSlotWhenStreamEnds(comp.modelGateway.createUIMessageStreamResponse({ stream: result.stream }), release);
  }
}
