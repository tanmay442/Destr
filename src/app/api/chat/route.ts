import {
  tool,
  convertToModelMessages,
  streamText,
  stepCountIs,
  createUIMessageStreamResponse,
  createUIMessageStream,
} from 'ai';
import { auth, currentUser } from '@clerk/nextjs/server';
import { getComposition, assertSameOrigin, type Composition, TRACE_ENABLED } from '@/composition';
import { chatTurn } from '@app/application/chat';
import { NextResponse, after } from 'next/server';
import { logger } from '@/lib/logger';
import { readBoundedText, respond } from '@/lib/http';
import { CHAT_MAX_BODY_BYTES, isRequestCancellationError } from '@app/domain';
import { getRuntimeConfig } from '@/lib/config/runtime';
import { judgeFaithfulness, judgeRelevance } from '@/composition';

type CompositionRateLimitDecision = Awaited<ReturnType<Composition['rateLimit']>>;
type RateLimitedDecision = { ok: false; retryAfterMs: number };
type RateLimitDecision = { ok: true; remaining: number; resetMs: number } | RateLimitedDecision;

function isRateLimited(decision: CompositionRateLimitDecision): decision is RateLimitedDecision {
  return decision.ok === false && 'retryAfterMs' in decision;
}

function normalizeRateLimitDecision(decision: CompositionRateLimitDecision): RateLimitDecision {
  if (isRateLimited(decision)) return decision;
  if (decision.ok === true && 'remaining' in decision && 'resetMs' in decision) {
    return { ok: true, remaining: decision.remaining, resetMs: decision.resetMs };
  }
  return { ok: false, retryAfterMs: 0 };
}

export const maxDuration = 60;

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
function scheduleFlush(comp: Composition): void {
  try {
    after(() => {
      void comp.chatEventBatcher.flush();
    });
  } catch {
    void comp.chatEventBatcher.flush();
  }
}

interface EventMetaPatcher {
  updateEventMeta(turnId: string, patch: Record<string, unknown>): Promise<boolean>;
}
interface BatcherMetaPatcher {
  patchMeta(turnId: string, patch: Record<string, unknown>): boolean;
}

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
      if (faithfulness.citationPrecision !== null) judgeScores.citationPrecision = faithfulness.citationPrecision;
    }
    const patch = { judgeScores };
    const buffered = ctx.batcherPatcher ? ctx.batcherPatcher.patchMeta(ctx.turnId, patch) : false;
    if (buffered) return;
    const persisted = ctx.eventMetaPatcher
      ? await ctx.eventMetaPatcher.updateEventMeta(ctx.turnId, patch)
      : false;
    if (!persisted) {
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

function scheduleAfter(task: () => void): void {
  try {
    after(() => task());
  } catch {
    task();
  }
}

async function streamChatResponseUseCase(req: Request): Promise<Response> {
  const turnStart = performance.now();
  const expWallStart = Date.now();
  const expMark = (label: string, extra?: Record<string, unknown>) => {
    const wallMs = Date.now() - expWallStart;
    const perfMs = Math.round(performance.now() - turnStart);
    logger.info('[exp-instr] chat-route phase', { label, wallMs, perfMs, ...extra });
    console.log(`[exp-instr] chat-route ${label} wallMs=${wallMs} perfMs=${perfMs}`, extra ?? '');
  };
  const turnSoftDeadlineMs = positiveIntEnv('CHAT_SOFT_DEADLINE_MS') ?? 50_000;
  const judgeMaxWallMs = positiveIntEnv('CHAT_JUDGE_MAX_WALL_MS') ?? 20_000;
  expMark('start', { cacheLeasePolicy: String(process.env.CACHE_LEASE_MODE ?? '(default)'), nodeEnv: process.env.NODE_ENV ?? '?' });
  const { userId } = await auth();
  expMark('auth', { hasUser: Boolean(userId) });
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
  expMark('readBoundedText', { ok: bounded.ok, reason: bounded.ok ? undefined : bounded.reason, bytes: bounded.ok ? bounded.text.length : 0 });
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
  expMark('composition', {
    cacheLeasePolicy: String((comp as unknown as { cacheLeasePolicy?: unknown }).cacheLeasePolicy ?? '?'),
    hasTurnResultCache: Boolean(comp.turnResultCache),
  });
  const chatTurnStart = performance.now();
  const result = await chatTurn(
    { request: boundedReq, userId, startedAt: turnStart },
    {
      ai: { streamText, tool, stepCountIs, convertToModelMessages, createUIMessageStream },
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
      expMark('result', { kind: result.kind, chatTurnMs: Math.round(performance.now() - chatTurnStart) });
      release();
      return new Response('Too Many Requests', {
        status: 429,
        ...(result.retryAfterSec ? { headers: { 'Retry-After': result.retryAfterSec } } : {}),
      });
    case 'cache-wait-timeout':
      expMark('result', { kind: result.kind, chatTurnMs: Math.round(performance.now() - chatTurnStart) });
      release();
      return new Response('The answer is still being generated. Please retry shortly.', {
        status: 503,
        headers: { 'Retry-After': '1' },
      });
    case 'cache-unavailable':
      expMark('result', { kind: result.kind, chatTurnMs: Math.round(performance.now() - chatTurnStart) });
      release();
      return new Response('Chat coordination is temporarily unavailable. Please retry shortly.', {
        status: 503,
        headers: { 'Retry-After': '1' },
      });
    case 'idempotency-conflict':
      expMark('result', { kind: result.kind, chatTurnMs: Math.round(performance.now() - chatTurnStart) });
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
      {
        const chatTurnMs = Math.round(performance.now() - chatTurnStart);
        const totalPreMs = Math.round(performance.now() - turnStart);
        expMark('result', { kind: 'stream', cacheHit: result.meta.cacheHit, mode: result.meta.mode, chatTurnMs, totalPreMs });
        const inner = createUIMessageStreamResponse({ stream: result.stream });
        const headers = new Headers(inner.headers);
        headers.set('X-Chat-Exp', 'instr');
        headers.set('X-Chat-PreMs', String(totalPreMs));
        headers.set('X-Chat-TurnMs', String(chatTurnMs));
        headers.set('Server-Timing', `pre;dur=${totalPreMs}, chatTurn;dur=${chatTurnMs}`);
        const withHeaders = new Response(inner.body, { status: inner.status, statusText: inner.statusText, headers });
        return releaseSlotWhenStreamEnds(withHeaders, release);
      }
  }
}

export async function POST(req: Request) {
  try {
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;
    return streamChatResponseUseCase(req);
  } catch (error) {
    const userId = chatSlotOwners.get(req);
    if (userId) releaseOwnedChatSlot(req, userId);
    if (req.signal.aborted && isRequestCancellationError(error)) return new Response(null, { status: 499 });
    logger.error('Chat request failed', { error: String(error) });
    return respond(error);
  }
}
