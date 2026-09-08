import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { err, ok, ExternalServiceError } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { AppConfig } from '@app/domain/app-config';
import { SearchFailure, type RetrievalDiagnostics, type RetrievedChunk } from '../../rag/search';
import type { AgenticResult } from '../../rag/agentic-search';
import { chatTurn, type ChatTurnDeps, type ChatTurnRequest, type ChatTurnResult } from '../chat-turn';
import { searchDocumentationInputSchema } from '../chat-turn/chat-tools';
import { legacySearchResultCacheFingerprint } from '../cache-key';
import { TURN_FINGERPRINT_VERSION, turnRequestFingerprint } from '../turn-fingerprint';
import type { ChatInputMessage } from '../message-types';

function agenticOk(overrides: Partial<AgenticResult> = {}): AgenticResult {
  return {
    chunks: [CHUNK],
    rewrittenQuery: 'rewritten',
    attemptedQueries: ['rewritten'],
    resultQuery: 'rewritten',
    degradedBy: [],
    outOfDomain: false,
    isEmpty: false,
    fallbackReason: null,
    resultState: 'results',
    retrievalDiagnostics: [],
    ...overrides,
  };
}

const { streamTextMock, stepCountMock, aiReal } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  stepCountMock: vi.fn((n: number) => `budget:${n}`),
  aiReal: {} as {
    tool?: typeof import('ai')['tool'];
    convertToModelMessages?: typeof import('ai')['convertToModelMessages'];
    createUIMessageStream?: typeof import('ai')['createUIMessageStream'];
  },
}));

const CHUNK: RetrievedChunk = {
  id: 1,
  documentId: 10,
  fileName: 'benefits.pdf',
  page: 3,
  sectionTitle: 'Dental',
  source: 'https://example.com/benefits.pdf',
  title: 'Benefits',
  content: 'The dental plan covers two cleanings per year.',
  chunkIndex: 0,
  scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' },
};

const CHUNK2: RetrievedChunk = {
  ...CHUNK,
  id: 2,
  chunkIndex: 1,
  content: 'Submit claims via the HR portal.',
  scores: { dense: 0.62, finalRank: 2, finalSignal: 'dense' },
};

function testDiagnostics(finalCount: number): RetrievalDiagnostics {
  return {
    requestedLimit: finalCount,
    candidateLimit: finalCount,
    documentFilterApplied: false,
    dense: { status: 'ok', candidateCount: finalCount },
    lexical: { status: 'not_run', candidateCount: 0, mode: 'weighted_websearch' },
    fusion: { applied: false, inputCount: finalCount, outputCount: finalCount },
    reranker: {
      status: 'not_configured', inputCount: 0, validCount: 0, acceptedCount: 0,
      threshold: null, thresholdFilteredCount: 0,
    },
    resolutionMode: 'parent',
    resolvedCount: finalCount,
    stableDuplicatesSkipped: 0,
    backfillCount: 0,
    hasMore: false,
    finalCount,
    finalRanks: Array.from({ length: finalCount }, (_, index) => index + 1),
  };
}

function makeCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    orgName: 'Test Corp',
    audience: 'test customers',
    agentPersona: { name: 'Destr', tone: 'friendly' },
    outOfScopeTopics: [],
    customInstructions: undefined,
    retrievalMode: 'normal',
    retrievalModeRolloutPercent: 100,
    agentStepBudget: 8,
    similarityThreshold: 0.5,
    hybridEnabled: true,
    agenticQueryRewriteEnabled: true,
    hallucinationCheckEnabled: true,
    judgeSampleRate: 0.02,
    rerankerProvider: 'cosine',
    auxModel: undefined,
    answerCacheEnabled: true,
    answerCacheTtlSec: 3600,
    captureQueryText: true,
    prefetchFirstTurn: false,
    ...overrides,
  } as AppConfig;
}

type DepsOverrides = Partial<Omit<ChatTurnDeps, 'getRuntimeConfig'>> & {
  cfg?: AppConfig;
};

function makeDeps(overrides: DepsOverrides = {}) {
  const cfg = overrides.cfg ?? makeCfg();
  const searchChunks = vi.fn<ChatTurnDeps['searchChunks']>(
    async () => ok({ chunks: [CHUNK, CHUNK2], degradedBy: [], diagnostics: testDiagnostics(2) }),
  );
  const agenticSearch = vi.fn(async () => ok(agenticOk()));
  const answerCache = {
    get: vi.fn(async () => null as string | null),
    set: vi.fn<(key: string, value: string, ttlSec: number) => Promise<void>>(async () => undefined),
    lease: {
      tryAcquire: vi.fn(async () => `test-token-${Math.random()}`),
      release: vi.fn(async () => undefined),
    },
  };
  const answerCacheKey = vi.fn((query: string, ctx: { userId?: string; fingerprint?: string }) =>
    `rag:answer:${query}-${ctx.userId ?? ''}-${ctx.fingerprint ?? ''}`,
  );
  const rateLimit = {
    check: vi.fn(
      async (_key: string, _opts: { limit: number; windowMs: number }): Promise<
        | { ok: true; remaining: number; resetMs: number }
        | { ok: false; retryAfterMs: number }
      > => {
        void _key;
        void _opts;
        return { ok: true, remaining: 29, resetMs: 60_000 };
      },
    ),
  };
  const createTicket = vi.fn(async () => ok({ ticketId: 'TKT-abcdef12', status: 'created' as const }));
  const userResolver = vi.fn(async () => ({
    userId: 'user_test',
    name: 'Real Person',
    email: 'real@example.com',
  })) as unknown as Mock & ChatTurnDeps['userResolver'];
  const record = vi.fn();
  const flush = vi.fn(async () => undefined);
  const appendTurn = vi.fn(async (...args: unknown[]) => {
    void args;
    return { conversationId: 'conv-1' };
  });
  const deps: ChatTurnDeps = {
    ai: {
      streamText: streamTextMock,
      stepCountIs: stepCountMock,
      tool: aiReal.tool,
      convertToModelMessages: aiReal.convertToModelMessages,
      createUIMessageStream: aiReal.createUIMessageStream,
    } as unknown as ChatTurnDeps['ai'],
    getChatModel: () => ({} as LanguageModelV3),
    getChatModelId: () => 'gpt-4o-mini',
    getEmbeddingModelId: () => 'emb-3',
    getRuntimeConfig: async () => cfg,
    searchChunks: overrides.searchChunks ?? searchChunks,
    agenticSearch: overrides.agenticSearch ?? agenticSearch,
    hallucinationGrader: overrides.hallucinationGrader ?? (() => null),
    answerCache: overrides.answerCache ?? answerCache,
    ...(overrides.turnResultCache ? { turnResultCache: overrides.turnResultCache } : {}),
    answerCacheKey: overrides.answerCacheKey ?? answerCacheKey,
    rateLimit: overrides.rateLimit ?? rateLimit,
    createTicket: overrides.createTicket ?? createTicket,
    userResolver: overrides.userResolver ?? userResolver,
    eventSink: overrides.eventSink ?? { record, flush },
    historySink: overrides.historySink ?? { appendTurn },
    ...(overrides.judgeScheduler ? { judgeScheduler: overrides.judgeScheduler } : {}),
    ...(overrides.qualityJudge ? { qualityJudge: overrides.qualityJudge } : {}),
    traceEnabled: overrides.traceEnabled ?? false,
  };
  return {
    deps,
    fakes: {
      cfg,
      searchChunks,
      agenticSearch,
      answerCache,
      answerCacheKey,
      rateLimit,
      createTicket,
      userResolver,
      record,
      flush,
      appendTurn,
    },
  };
}

function makeRequest(body: unknown, init: { signal?: AbortSignal } = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

const BASIC_BODY: { turnId: string; messages: ChatInputMessage[] } = {
  turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'How do I reset my password?' }] }],
};

function scriptedStream(): ReadableStream<{ type: string; [k: string]: unknown }> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'a' });
      controller.enqueue({ type: 'text-delta', id: 'a', delta: 'Hello' });
      controller.enqueue({ type: 'text-delta', id: 'a', delta: ' world' });
      controller.enqueue({ type: 'text-end', id: 'a' });
      controller.close();
    },
  });
}

function defaultStreamTextResult(overrides: { text?: string } = {}) {
  return {
    toUIMessageStream: () => scriptedStream() as Readonly<unknown> as never,
    text: Promise.resolve(overrides.text ?? 'Hello world'),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
  };
}

async function readParts(stream: ReadableStream): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = (stream as ReadableStream<unknown>).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

async function run(input: ChatTurnRequest, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  return chatTurn(input, deps);
}

type TicketArgs = {
  question: string;
  attempted: string[];
  documentationSearched: string[];
  context?: string;
};

type CapturedTools = {
  searchDocumentation?: {
    execute: (args: { query: string; limit?: number }, options?: { toolCallId: string }) => Promise<unknown>;
  };
  createKnowledgeTicket?: { execute: (args: TicketArgs) => Promise<unknown> };
};

const TICKET_BODY = {
  turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'How do I reset my password? Please open a ticket.' }] }],
} as unknown as { turnId: string; messages: ChatInputMessage[] };

function ticketArgs(overrides: Partial<TicketArgs> = {}): TicketArgs {
  return {
    question: 'Cannot reset my password.',
    attempted: ['searched password reset'],
    documentationSearched: ['password reset'],
    ...overrides,
  };
}

function captureTools(overrides: { text?: string } = {}): {
  captured: { current: CapturedTools | undefined };
  closeLlm: () => void;
} {
  const captured: { current: CapturedTools | undefined } = { current: undefined };
  let llmController: ReadableStreamDefaultController | null = null;
  streamTextMock.mockImplementation((opts: { tools?: CapturedTools }) => {
    captured.current = opts?.tools;
    const stream = new ReadableStream({
      start(controller) {
        llmController = controller;
      },
    });
    return {
      toUIMessageStream: () => stream as unknown as never,
      text: Promise.resolve(overrides.text ?? 'Hello world'),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
  });
  return {
    captured,
    closeLlm: () => llmController?.close(),
  };
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  aiReal.tool = actual.tool;
  aiReal.convertToModelMessages = actual.convertToModelMessages;
  aiReal.createUIMessageStream = actual.createUIMessageStream;
  streamTextMock.mockReset();
  stepCountMock.mockClear();
  streamTextMock.mockImplementation(() => defaultStreamTextResult());
});

describe('chatTurn', () => {
  it('returns a stream response for a valid request', async () => {
    const { deps } = makeDeps();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const parts = await readParts(result.stream);
    expect(parts.map((p) => (p as { type: string }).type)).toEqual([
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
    ]);
  });

  it('rejects when the rate limiter denies the turn', async () => {
    const { deps, fakes } = makeDeps();
    fakes.rateLimit.check.mockResolvedValueOnce({ ok: false, retryAfterMs: 5000 } as never);
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result).toEqual({ kind: 'rate-limited', retryAfterSec: '5' });
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid request body', async () => {
    const { deps } = makeDeps();
    const result = await run({ request: makeRequest({}), userId: 'user_test' }, deps);
    expect(result.kind).toBe('invalid-request');
  });

  it('rejects a payload that is too large after parsing', async () => {
    const { deps } = makeDeps();
    const big = 'x'.repeat(1_100_000);
    const result = await run(
      { request: makeRequest({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: big }] }] }), userId: 'user_test' },
      deps,
    );
    expect(result.kind).toBe('payload-too-large');
  });

  it('replays a cached answer without calling the model', async () => {
    const { deps, fakes } = makeDeps();
    fakes.answerCache.get.mockResolvedValueOnce('cached answer');
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(result.meta.cacheHit).toBe(true);
    const parts = await readParts(result.stream);
    expect(parts).toEqual([
      { type: 'text-start', id: 'cached' },
      { type: 'text-delta', id: 'cached', delta: 'cached answer' },
      { type: 'text-end', id: 'cached' },
    ]);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.cacheHit).toBe(true);
    expect(event?.mode).toBe('vector');
  });

  it('replays no-citation v2 search state metadata into the cache-hit event', async () => {
    const { deps, fakes } = makeDeps();
    fakes.answerCache.get.mockResolvedValueOnce(JSON.stringify({
      v: 2,
      text: 'Search is temporarily unavailable.',
      citations: [],
      search: { resultStates: ['error'], scoreMaxima: {} },
    }));
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    const event = fakes.record.mock.calls.at(-1)?.[0] as { citationCount?: number; meta?: Record<string, unknown> };
    expect(event.citationCount).toBeUndefined();
    expect(event.meta).toMatchObject({ search: { resultStates: ['error'], scoreMaxima: {} } });
  });

  it('replays a completed turn by turn ID without calling the model again', async () => {
    const cfg = makeCfg({ prefetchFirstTurn: true });
    const values = new Map<string, string>();
    const turnResultCache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const { deps, fakes } = makeDeps({ cfg, turnResultCache });
    streamTextMock.mockImplementation(() => defaultStreamTextResult({ text: 'once' }));

    const first = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(first.kind).toBe('stream');
    if (first.kind !== 'stream') return;
    await readParts(first.stream);

    const second = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(second.kind).toBe('stream');
    if (second.kind !== 'stream') return;
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(await readParts(second.stream)).toContainEqual({ type: 'text-delta', id: 'cached', delta: 'once' });
    expect(turnResultCache.set).toHaveBeenCalledWith(
      expect.stringContaining('rag:turn-result:v2:'),
      expect.stringContaining('turn-result'),
      86_400,
    );
    const stableKey = [...values.keys()].find((key) => key.startsWith('rag:turn-result:user_test:'));
    const versionedKey = [...values.keys()].find((key) => key.startsWith('rag:turn-result:v2:'));
    expect(stableKey).toBeDefined();
    expect(versionedKey).toBeDefined();
    const compatibilityPayload = JSON.parse(values.get(stableKey!)!) as Record<string, unknown>;
    const versionedPayload = JSON.parse(values.get(versionedKey!)!) as Record<string, unknown>;
    expect(compatibilityPayload).toMatchObject({
      v: 1,
      kind: 'turn-result',
      fingerprintVersion: TURN_FINGERPRINT_VERSION,
      text: 'once',
      citations: [],
    });
    expect(compatibilityPayload.requestFingerprint).toBe(turnRequestFingerprint({
      semanticContext: legacySearchResultCacheFingerprint(cfg, 'normal'),
      messages: BASIC_BODY.messages,
    }));
    expect(versionedPayload).toMatchObject({
      v: 2,
      kind: 'turn-result',
      text: 'once',
    });
    expect(versionedPayload.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ scores: expect.objectContaining({ finalRank: 1 }) }),
    ]));
    expect(fakes.record.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ cacheHit: true }));
  });

  it('replays a WP-0 turn-result record through the stable compatibility key', async () => {
    const cfg = makeCfg();
    const stableKey = `rag:turn-result:user_test:${BASIC_BODY.turnId}`;
    const priorFingerprint = turnRequestFingerprint({
      semanticContext: legacySearchResultCacheFingerprint(cfg, cfg.retrievalMode),
      messages: BASIC_BODY.messages,
    });
    const turnResultCache = {
      get: vi.fn(async (key: string) => key === stableKey
        ? JSON.stringify({
            v: 1,
            kind: 'turn-result',
            requestFingerprint: priorFingerprint,
            fingerprintVersion: TURN_FINGERPRINT_VERSION,
            text: 'completed before WP-1',
            citations: [],
          })
        : null),
      set: vi.fn(async () => undefined),
    };
    const { deps } = makeDeps({ cfg, turnResultCache });

    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);

    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(await readParts(result.stream)).toContainEqual({
      type: 'text-delta',
      id: 'cached',
      delta: 'completed before WP-1',
    });
    expect(turnResultCache.get).toHaveBeenCalledWith(stableKey);
    expect(turnResultCache.set).not.toHaveBeenCalled();
  });

  it('waits on the stable turn lease when a WP-0 deployment owns it', async () => {
    const cfg = makeCfg();
    const stableKey = `rag:turn-result:user_test:${BASIC_BODY.turnId}`;
    const priorFingerprint = turnRequestFingerprint({
      semanticContext: legacySearchResultCacheFingerprint(cfg, cfg.retrievalMode),
      messages: BASIC_BODY.messages,
    });
    const compatibilityPayload = JSON.stringify({
      v: 1,
      kind: 'turn-result',
      requestFingerprint: priorFingerprint,
      fingerprintVersion: TURN_FINGERPRINT_VERSION,
      text: 'completed by WP-0 owner',
      citations: [],
    });
    let stableReads = 0;
    const acquire = vi.fn(async () => ({ kind: 'held' as const }));
    const turnResultCache = {
      get: vi.fn(async (key: string) => {
        if (key !== stableKey) return null;
        stableReads += 1;
        return stableReads === 1 ? null : compatibilityPayload;
      }),
      set: vi.fn(async () => undefined),
      coordination: { scope: 'distributed' as const, acquire },
    };
    const { deps } = makeDeps({ cfg, turnResultCache });

    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);

    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledWith(stableKey, expect.any(Number));
    expect(await readParts(result.stream)).toContainEqual({
      type: 'text-delta',
      id: 'cached',
      delta: 'completed by WP-0 owner',
    });
  });

  it('rejects reuse of a turn ID for a different request', async () => {
    const values = new Map<string, string>();
    const turnResultCache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };
    const { deps } = makeDeps({ turnResultCache });
    const first = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(first.kind).toBe('stream');
    if (first.kind !== 'stream') return;
    await readParts(first.stream);

    const conflictBody = {
      ...BASIC_BODY,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'A different question' }] }],
    };
    const second = await run({ request: makeRequest(conflictBody), userId: 'user_test' }, deps);
    expect(second).toEqual({ kind: 'idempotency-conflict' });
  });

  it('writes a freshly generated grounded first-turn answer to the cache on miss', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    streamTextMock.mockImplementation(() => defaultStreamTextResult({ text: 'freshly generated answer' }));
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    expect(fakes.answerCache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = fakes.answerCache.set.mock.calls[0]!;
    expect(key).toMatch(/^rag:answer:/);
    const payload = JSON.parse(value) as {
      v: number;
      text: string;
      citations: Array<{ id: number; snippet: string; scores: RetrievedChunk['scores'] }>;
      search: { resultStates: string[]; scoreMaxima: Record<string, number> };
    };
    expect(payload.v).toBe(2);
    expect(payload.text).toBe('freshly generated answer');
    expect(payload.citations.map((c) => c.id)).toEqual([1, 2]);
    expect(payload.citations.map((c) => c.scores.finalRank)).toEqual([1, 2]);
    expect(payload.citations[0]).not.toHaveProperty('similarity');
    expect(payload.search).toEqual({
      resultStates: ['results'],
      scoreMaxima: { dense: 0.91 },
    });
    expect(ttl).toBe(3600);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.tokensIn).toBe(10);
    expect(event?.tokensOut).toBe(5);
    expect(event?.cacheHit).toBeFalsy();
  });

  it('does not cache a first-turn answer that has no citations (ungrounded)', async () => {
    const { deps, fakes } = makeDeps();
    streamTextMock.mockImplementation(() => defaultStreamTextResult({ text: 'ungrounded answer' }));
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('never consults the cache on a follow-up turn', async () => {
    const { deps, fakes } = makeDeps();
    const body = {
      messages: [
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and for grade 7?' }] },
      ],
    };
    const result = await run({ request: makeRequest(body), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    expect(fakes.answerCache.get).not.toHaveBeenCalled();
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('includes user id and retrieval fingerprint in the cache key context', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ retrievalMode: 'agentic' }) });
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_fp' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    const [, ctx] = fakes.answerCacheKey.mock.calls.at(-1)! as unknown as [
      string,
      { embeddingModel: string; chatModel: string; userId: string; fingerprint: string },
    ];
    expect(ctx.userId).toBe('user_fp');
    expect(ctx.embeddingModel).toBe('emb-3');
    expect(ctx.chatModel).toBe('gpt-4o-mini');
    expect(ctx.fingerprint).toContain('"mode":"agentic"');
    expect(ctx.fingerprint).toContain('"retrievalMode":"agentic"');
    expect(ctx.fingerprint).toContain('"promptVersion":4');
    expect(ctx.fingerprint).toContain('"resultContractVersion":2');
  });

  it('does not cache an out-of-domain answer', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () =>
        ok(agenticOk({ chunks: [], resultQuery: null, outOfDomain: true, isEmpty: true, resultState: 'no_match' })),
      ),
      hallucinationGrader: () => async () => 'yes' as const,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    expect(parts.some((p) => (p as { type: string }).type === 'data-guardrail')).toBe(true);
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.outOfDomain).toBe(true);
    expect(event?.hallucinationBlocked).toBe(true);
  });

  it('does not turn a later empty search into an out-of-domain wall after evidence was found', async () => {
    const longChunk = { ...CHUNK, content: `${'x'.repeat(300)} supported detail` };
    const grader = vi.fn(async () => 'yes' as const);
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi
        .fn()
        .mockResolvedValueOnce(ok(agenticOk({ chunks: [longChunk] })))
        .mockResolvedValueOnce(ok(agenticOk({ chunks: [], resultQuery: null, outOfDomain: true, isEmpty: true, resultState: 'no_match' }))),
      hallucinationGrader: () => grader,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const firstOutput = await captured.current?.searchDocumentation?.execute({ query: 'q' });
    const secondOutput = await captured.current?.searchDocumentation?.execute({ query: 'q again' });
    closeLlm();
    const parts = await readParts(result.stream);
    expect(firstOutput).toMatchObject({
      sets: [{ kind: 'results', results: [{ subquestionId: 'sq-1' }] }],
      uniqueEvidenceAdded: 1,
    });
    expect(secondOutput).toMatchObject({
      sets: [{ kind: 'no_match', reason: 'no_relevant_evidence', ticketEligible: true }],
      uniqueEvidenceAdded: 0,
    });
    expect(parts.some((p) => (p as { type: string }).type === 'data-guardrail')).toBe(false);
    expect(grader).toHaveBeenCalledWith(expect.stringContaining('supported detail'), 'Hello world');
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.outOfDomain).toBe(false);
    expect(event?.hitCount).toBe(1);
  });

  it('emits a guardrail and skips the cache when the hallucination grader blocks', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      hallucinationGrader: () => async () => 'no' as const,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    const guardrail = parts.find((p) => (p as { type: string }).type === 'data-guardrail') as {
      data: { outOfDomain: boolean; offerTicket: boolean };
    };
    expect(guardrail).toBeDefined();
    expect(guardrail.data).toEqual({ outOfDomain: false, offerTicket: true });
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.hallucinationBlocked).toBe(true);
  });

  it('skips the guardrail and caches when the answer is grounded', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      hallucinationGrader: () => async () => 'yes' as const,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    expect(parts.some((p) => (p as { type: string }).type === 'data-guardrail')).toBe(false);
    expect(fakes.answerCache.set).toHaveBeenCalledTimes(1);
  });

  it('emits deduplicated citations after the llm stream ends', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    expect(captured.current?.searchDocumentation).toBeDefined();
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    await captured.current?.searchDocumentation?.execute({ query: 'q again' });
    closeLlm();
    const parts = await readParts(result.stream);
    const citations = parts.filter((p) => (p as { type: string }).type === 'data-citation') as Array<{
      data: { scores: RetrievedChunk['scores']; snippet: string };
    }>;
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.data.scores.dense)).toEqual([0.91, 0.62]);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.citationCount).toBe(2);
    expect((event?.meta as Record<string, unknown>)?.documentIds).toEqual([10]);
  });

  it('does not pass duplicate chunks to the model or citation stream', async () => {
    const { deps, fakes } = makeDeps();
    fakes.searchChunks.mockResolvedValue(ok({ chunks: [CHUNK], degradedBy: [] }) as never);
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const firstOutput = await captured.current?.searchDocumentation?.execute({ query: 'q' });
    const secondOutput = await captured.current?.searchDocumentation?.execute({ query: 'q again' });
    closeLlm();
    expect(firstOutput).toMatchObject({ sets: [{ kind: 'results', results: [{ id: 1 }] }] });
    expect(secondOutput).toMatchObject({
      sets: [{ kind: 'no_match', reason: 'filtered_duplicates', ticketEligible: false }],
    });
    const parts = await readParts(result.stream);
    const citations = parts.filter((p) => (p as { type: string }).type === 'data-citation');
    expect(citations).toHaveLength(1);
  });

  it('passes prior stable identities so a later overlapping call can backfill unseen evidence', async () => {
    const exclusionSnapshots: string[][] = [];
    const searchChunks = vi.fn<ChatTurnDeps['searchChunks']>(async (_cfg, _query, opts) => {
      exclusionSnapshots.push([...opts.excludeChunkIdentities ?? []]);
      const next = exclusionSnapshots.length === 1 ? CHUNK : CHUNK2;
      return ok({ chunks: [next], degradedBy: [], diagnostics: testDiagnostics(1) });
    });
    const { deps } = makeDeps({ searchChunks });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');

    const first = await captured.current?.searchDocumentation?.execute({ query: 'policy' });
    const second = await captured.current?.searchDocumentation?.execute({ query: 'policy details' });
    closeLlm();
    const parts = await readParts(result.stream);

    expect(first).toMatchObject({ sets: [{ kind: 'results', results: [{ id: 1 }] }] });
    expect(second).toMatchObject({
      sets: [{ kind: 'results', results: [{ id: 2 }] }],
      uniqueEvidenceAdded: 1,
    });
    expect(exclusionSnapshots).toEqual([[], ['document_chunk:10:0']]);
    expect(parts.filter((part) => (part as { type: string }).type === 'data-citation')).toHaveLength(2);
  });

  it('caps tool content at 800 chars with an ellipsis, wrapped in untrusted reference framing', async () => {
    const { deps, fakes } = makeDeps();
    fakes.searchChunks.mockResolvedValueOnce(ok({
      chunks: [{ ...CHUNK, content: 'x'.repeat(2000) }],
      degradedBy: [],
    }) as never);
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.searchDocumentation?.execute({ query: 'q' })) as {
      sets: Array<{ kind: string; results?: Array<{ content: string }> }>;
    };
    const content = out.sets[0]?.results?.[0]?.content ?? '';
    expect(content).toContain('~~~ BEGIN UNTRUSTED EVIDENCE');
    expect(content).toContain('~~~ END UNTRUSTED EVIDENCE ~~~');
    expect(content).toContain('untrusted documentation evidence');
    expect(content).toContain('x'.repeat(800));
    expect(content).toContain('\u2026');
    expect(content).not.toContain('x'.repeat(801));
  });

  it('uses the agentic retrieval path with a rewritten query flag when effective mode is agentic', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ retrievalMode: 'agentic' }) });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'vague' });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.agenticSearch).toHaveBeenCalledWith(fakes.cfg, 'vague', {
      excludeChunkIdentities: expect.any(Set),
      limit: 3,
      signal: expect.any(AbortSignal),
    });
    expect(fakes.searchChunks).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect((event?.meta as Record<string, unknown>)?.rewritten).toBe(true);
    expect(event?.mode).toBe('agentic');
  });

  it('gates on effective mode, not function truthiness: normal mode uses plain search', async () => {
    const { deps, fakes } = makeDeps();
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'plain' });
    expect(fakes.searchChunks).toHaveBeenCalledWith(fakes.cfg, 'plain', {
      excludeChunkIdentities: expect.any(Set),
      limit: 3,
      signal: expect.any(AbortSignal),
    });
    expect(fakes.agenticSearch).not.toHaveBeenCalled();
  });

  it.each(['normal', 'agentic'] as const)('honors the requested result limit in %s mode', async (mode) => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ retrievalMode: mode }) });
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const output = await captured.current?.searchDocumentation?.execute(
      { query: 'policy', limit: 1 },
      { toolCallId: `tool-${mode}` },
    );
    expect(output).toMatchObject({
      callId: `tool-${mode}`,
      sets: [{
        kind: 'results',
        subquestionId: 'sq-1',
        executedQueries: [{ queryId: 'q-1', query: mode === 'agentic' ? 'rewritten' : 'policy' }],
        results: [{ executedQueryIds: ['q-1'], subquestionId: 'sq-1' }],
      }],
      uniqueEvidenceAdded: 1,
    });
    if (mode === 'agentic') {
      expect(fakes.agenticSearch).toHaveBeenCalledWith(fakes.cfg, 'policy', {
        excludeChunkIdentities: expect.any(Set),
        limit: 1,
        signal: expect.any(AbortSignal),
      });
    } else {
      expect(fakes.searchChunks).toHaveBeenCalledWith(fakes.cfg, 'policy', {
        excludeChunkIdentities: expect.any(Set),
        limit: 1,
        signal: expect.any(AbortSignal),
      });
    }
  });

  it('rejects a whitespace-only query at the tool input boundary', () => {
    expect(searchDocumentationInputSchema.safeParse({ query: '   ' }).success).toBe(false);
    expect(searchDocumentationInputSchema.parse({ query: '  password reset  ' }).query).toBe('password reset');
  });

  it.each([
    ['embedding_unavailable', true],
    ['retrieval_unavailable', true],
    ['timeout', true],
    ['cancelled', false],
  ] as const)('returns a sanitized %s tool error without ticket eligibility', async (code, retryable) => {
    const failure = new SearchFailure(code, retryable, 'Safe search failure message.');
    const { deps } = makeDeps({
      searchChunks: vi.fn(async () => err(failure)),
    });
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const output = await captured.current?.searchDocumentation?.execute({ query: 'policy' });
    expect(output).toMatchObject({
      sets: [{ kind: 'error', code, retryable, userSafeMessage: 'Safe search failure message.' }],
      uniqueEvidenceAdded: 0,
    });
    expect((output as { sets: Array<Record<string, unknown>> }).sets[0]).not.toHaveProperty('ticketEligible');
  });

  it('prevents a search infrastructure error from enabling a ticket side effect', async () => {
    const { deps, fakes } = makeDeps({
      searchChunks: vi.fn(async () => err(new SearchFailure(
        'retrieval_unavailable',
        true,
        'The documentation search is temporarily unavailable. Please try again.',
      ))),
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'policy' });
    const ticket = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'Search failed' }));
    closeLlm();
    await readParts(result.stream);
    expect(ticket).toMatchObject({ ticketId: null, status: 'denied' });
    expect(fakes.createTicket).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as { outOfDomain?: boolean; meta?: Record<string, unknown> };
    expect(event.outOfDomain).toBe(false);
    expect(event.meta?.resultState).toBe('error');
  });

  it('returns a partial degraded result and blocks a ticket side effect', async () => {
    const { deps, fakes } = makeDeps({
      searchChunks: vi.fn(async () => ok({
        chunks: [CHUNK],
        degradedBy: ['lexical_unavailable'] as const,
        diagnostics: testDiagnostics(1),
      })),
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const output = await captured.current?.searchDocumentation?.execute({ query: 'policy' });
    const ticket = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'Search was degraded' }));
    closeLlm();
    await readParts(result.stream);
    expect(output).toMatchObject({
      sets: [{
        kind: 'results',
        coverage: 'partial',
        degradedBy: ['lexical_unavailable'],
        results: [{ scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' } }],
      }],
    });
    expect(ticket).toMatchObject({ ticketId: null, status: 'denied' });
    expect(fakes.createTicket).not.toHaveBeenCalled();
  });

  it('uses agentic executed-query provenance in an error result', async () => {
    const failure = new SearchFailure(
      'retrieval_unavailable',
      true,
      'Safe search failure message.',
      undefined,
      ['rewritten policy query'],
    );
    const { deps } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () => err(failure)),
    });
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const output = await captured.current?.searchDocumentation?.execute({ query: 'policy' });
    expect(output).toMatchObject({
      sets: [{ kind: 'error', requestedQuery: 'policy', attemptedQueries: ['rewritten policy query'] }],
    });
  });

  it('applies the agentic step budget when effective mode is agentic', async () => {
    const { deps } = makeDeps({ cfg: makeCfg({ retrievalMode: 'agentic', agentStepBudget: 8 }) });
    await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    const opts = streamTextMock.mock.calls[0]?.[0] as { stopWhen: unknown };
    expect(opts.stopWhen).toBe('budget:8');
    expect(stepCountMock).toHaveBeenCalledWith(8);
  });

  it('applies the fixed budget of 5 steps in normal mode', async () => {
    const { deps } = makeDeps();
    await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    const opts = streamTextMock.mock.calls[0]?.[0] as { stopWhen: unknown };
    expect(opts.stopWhen).toBe('budget:5');
    expect(stepCountMock).toHaveBeenCalledWith(5);
  });

  it('propagates the request abort signal to the model call', async () => {
    const { deps } = makeDeps();
    const controller = new AbortController();
    const result = await run(
      { request: makeRequest(BASIC_BODY, { signal: controller.signal }), userId: 'user_test' },
      deps,
    );
    expect(result.kind).toBe('stream');
    const opts = streamTextMock.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    expect(opts.abortSignal).toBeDefined();
    controller.abort();
    expect(opts.abortSignal.aborted).toBe(true);
  });

  it('creates a ticket via the createKnowledgeTicket tool using the resolved user profile', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.createKnowledgeTicket?.execute(
      ticketArgs({ question: 'Cannot reset my password.' }),
    )) as { ticketId: string; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(out.status).toBe('created');
    expect(out.ticketId).toBe('TKT-abcdef12');
    expect(fakes.createTicket).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'Real Person',
      email: 'real@example.com',
      issue: expect.stringContaining('Question: Cannot reset my password.'),
    });
    expect(fakes.userResolver).toHaveBeenCalledTimes(1);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.ticketCreated).toBe(true);
    expect((event?.meta as Record<string, unknown>)?.ticketId).toBe('TKT-abcdef12');
  });

  it('does not cache a turn that opened a knowledge ticket', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'please open a ticket' }));
    closeLlm();
    await readParts(result.stream);
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('returns an error status when createTicket fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.createTicket.mockResolvedValueOnce(err(new ExternalServiceError('db down')) as never);
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'my issue' }))) as { ticketId: null; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(out).toMatchObject({ ticketId: null, status: 'error' });
  });

  it('blocks a second ticket creation in the same turn', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const first = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'first ticket' }));
    const second = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'second ticket' }));
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ticketId: 'TKT-abcdef12', status: 'created' });
    expect(second).toMatchObject({ ticketId: null, status: 'denied' });
    expect((second as { message?: string }).message).toContain('already created');
  });

  it('rate limits ticket creation to one per user per 5 minutes', async () => {
    const { deps, fakes } = makeDeps();
    fakes.rateLimit.check.mockImplementation(async (key: string) =>
      key.startsWith('ticket:')
        ? { ok: false, retryAfterMs: 120_000 }
        : { ok: true, remaining: 29, resetMs: 60_000 },
    );
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'blocked by rate limit' }));
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ticketId: null, status: 'denied' });
    expect((out as { message?: string }).message).toContain('rate limited');
    expect(fakes.rateLimit.check).toHaveBeenCalledWith('ticket:user_test', { limit: 1, windowMs: 300_000 });
  });

  it('falls back to Unknown / synthetic email when the resolver has no profile', async () => {
    const { deps, fakes } = makeDeps();
    fakes.userResolver.mockResolvedValueOnce({ userId: 'user_test' });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'x' }));
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'User',
      email: 'user_test@clerk.user',
      issue: expect.stringContaining('Question: x'),
    });
  });

  it('pre-fetches chunks into the system prompt on the first turn when enabled', async () => {
    const { deps } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    const opts = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(opts.system).toMatch(/Pre-fetched Reference Data/);
    expect(opts.system).toContain('The dental plan covers two cleanings per year.');
  });

  it('reuses a normalized exact-match prefetch once and records that path', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const output = await captured.current?.searchDocumentation?.execute({ query: '  how do i reset my password?  ' });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.searchChunks).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ sets: [{ kind: 'results', coverage: 'sufficient', degradedBy: [] }] });
    const event = fakes.record.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> };
    expect(event.meta?.prefetch).toEqual(expect.objectContaining({ status: 'exact_match_reused' }));
    expect(event.meta?.reformulationCount).toBe(0);
    expect(event.meta?.search).toEqual(expect.objectContaining({ resultStates: ['results'] }));
  });

  it('returns a typed no-match when an exact-match prefetch found no evidence', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    fakes.searchChunks.mockResolvedValueOnce(ok({ chunks: [], degradedBy: [], diagnostics: testDiagnostics(0) }));
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const output = await captured.current?.searchDocumentation?.execute({
      query: 'How do I reset my password?',
    });
    closeLlm();
    await readParts(result.stream);
    expect(output).toMatchObject({
      sets: [{ kind: 'no_match', reason: 'no_relevant_evidence', ticketEligible: true }],
      uniqueEvidenceAdded: 0,
    });
    expect(fakes.searchChunks).toHaveBeenCalledTimes(1);
    const event = fakes.record.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> };
    expect(event.meta?.search).toEqual(expect.objectContaining({ resultStates: ['no_match'] }));
  });

  it('preserves degraded prefetch provenance and blocks ticket creation', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    fakes.searchChunks.mockResolvedValueOnce(ok({
      chunks: [CHUNK],
      degradedBy: ['lexical_unavailable'],
      diagnostics: testDiagnostics(1),
    }));
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const output = await captured.current?.searchDocumentation?.execute({
      query: 'How do I reset my password?',
    });
    const ticket = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'Search degraded' }));
    closeLlm();
    await readParts(result.stream);
    expect(output).toMatchObject({
      sets: [{ kind: 'results', coverage: 'partial', degradedBy: ['lexical_unavailable'] }],
    });
    expect(ticket).toMatchObject({ ticketId: null, status: 'denied' });
    expect(fakes.createTicket).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> };
    expect(event.meta?.search).toEqual(expect.objectContaining({ resultStates: ['degraded'] }));
  });

  it('performs a new search for a reformulated prefetch query and records it', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'password recovery policy' });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.searchChunks).toHaveBeenCalledTimes(2);
    const event = fakes.record.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> };
    expect(event.meta?.prefetch).toEqual(expect.objectContaining({ status: 'query_changed' }));
    expect(event.meta?.reformulationCount).toBe(1);
  });

  it('does not pre-fetch on a follow-up turn even when enabled', async () => {
    const { deps } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    const body = {
      messages: [
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and for grade 7?' }] },
      ],
    };
    await run({ request: makeRequest(body), userId: 'user_test' }, deps);
    const opts = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(opts.system).not.toMatch(/Pre-fetched Reference Data/);
  });

  it('preserves a prefetch failure and prevents it from enabling a ticket', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    fakes.searchChunks.mockResolvedValueOnce(err(new SearchFailure(
      'retrieval_unavailable',
      true,
      'The documentation search is temporarily unavailable. Please try again.',
    )));
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const opts = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(opts.system).not.toMatch(/Pre-fetched Reference Data/);
    const output = await captured.current?.searchDocumentation?.execute({
      query: 'How do I reset my password?',
    });
    const ticket = await captured.current?.createKnowledgeTicket?.execute(ticketArgs({ question: 'Search failed' }));
    closeLlm();
    await readParts(result.stream);
    expect(output).toMatchObject({ sets: [{ kind: 'error', code: 'retrieval_unavailable' }] });
    expect(ticket).toMatchObject({ ticketId: null, status: 'denied' });
    expect(fakes.createTicket).not.toHaveBeenCalled();
    const event = fakes.record.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> };
    expect(event.meta?.search).toEqual(expect.objectContaining({ resultStates: ['error'] }));
  });

  it('inverts the configured mode when the rollout dice misses', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ retrievalMode: 'normal', retrievalModeRolloutPercent: 0 }) });
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const opts = streamTextMock.mock.calls[0]?.[0] as { stopWhen: unknown };
    expect(opts.stopWhen).toBe('budget:8');
    await readParts(result.stream);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.mode).toBe('agentic');
  });

  it('omits query text from events when captureQueryText is disabled', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ captureQueryText: false }) });
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readParts(result.stream);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.query).toBeNull();
  });
});

describe('chat history persistence', () => {
  const HISTORY_BODY = {
    ...BASIC_BODY,
    conversationId: 'a0000000-0000-4000-8000-000000000001',
  };

  it('persists a completed turn through the history sink', async () => {
    const { deps, fakes } = makeDeps();
    const scripted = captureTools({ text: 'grounded answer' });
    const result = await run({ request: makeRequest(HISTORY_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await scripted.captured.current!.searchDocumentation!.execute({ query: 'reset password' });
    scripted.closeLlm();
    await readParts(result.stream);
    expect(fakes.appendTurn).toHaveBeenCalledTimes(1);
    const call = fakes.appendTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.userId).toBe('user_test');
    expect(call.conversationId).toBe('a0000000-0000-4000-8000-000000000001');
    expect(call.title).toBe('How do I reset my password?');
    expect((call.userMessage as { id: string }).id).toBe('m1');
    const assistant = call.assistantMessage as { parts: Array<{ type: string; text?: string; data?: unknown }> };
    expect(assistant.parts[0]).toEqual({ type: 'text', text: 'grounded answer' });
    const citationParts = assistant.parts.filter((p) => p.type === 'data-citation');
    expect(citationParts.length).toBeGreaterThan(0);
  });

  it('persists cached-answer turns through the same sink shape', async () => {
    const { deps, fakes } = makeDeps();
    fakes.answerCache.get.mockResolvedValueOnce('cached answer');
    const result = await run({ request: makeRequest(HISTORY_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream);
    expect(fakes.appendTurn).toHaveBeenCalledTimes(1);
    const call = fakes.appendTurn.mock.calls[0]![0] as Record<string, unknown>;
    const assistant = call.assistantMessage as { parts: Array<{ type: string; text?: string }> };
    expect(assistant.parts[0]).toEqual({ type: 'text', text: 'cached answer' });
  });

  it('skips persistence when captureQueryText is off', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ captureQueryText: false }) });
    const result = await run({ request: makeRequest(HISTORY_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream);
    expect(fakes.appendTurn).not.toHaveBeenCalled();
  });

  it('does not persist when the stream errors before completion', async () => {
    const { deps, fakes } = makeDeps();
    fakes.record.mockImplementation(() => {
      throw new Error('analytics exploded');
    });
    const result = await run({ request: makeRequest(HISTORY_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream).catch(() => undefined);
    expect(fakes.appendTurn).not.toHaveBeenCalled();
  });

  it('does not persist when the turn is aborted mid-stream', async () => {
    const { deps, fakes } = makeDeps();
    const abortController = new AbortController();
    abortController.abort();
    streamTextMock.mockImplementation(() => ({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'a' });
            controller.error(new Error('This operation was aborted'));
          },
        }) as unknown as never,
      text: Promise.resolve('partial answer'),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    }));
    const result = await run(
      { request: makeRequest(HISTORY_BODY, { signal: abortController.signal }), userId: 'user_test' },
      deps,
    );
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream).catch(() => undefined);
    expect(fakes.appendTurn).not.toHaveBeenCalled();
  });

  it('swallows sink failures without breaking the stream', async () => {
    const { deps } = makeDeps({
      historySink: { appendTurn: vi.fn(async () => { throw new Error('db down'); }) },
    });
    const result = await run({ request: makeRequest(HISTORY_BODY), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const parts = await readParts(result.stream);
    expect(parts.length).toBeGreaterThan(0);
  });

  it('forwards retryOfMessageId when the retry flag is set', async () => {
    const { deps, fakes } = makeDeps();
    const retryBody = { ...HISTORY_BODY, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] }], retry: true };
    const result = await run({ request: makeRequest(retryBody), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream);
    const call = fakes.appendTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.retryOfMessageId).toBe('m1');
  });

  it('still answers but does not persist when the request has no conversationId', async () => {
    const { deps, fakes } = makeDeps();
    const body = { ...HISTORY_BODY };
    delete (body as Record<string, unknown>).conversationId;
    const result = await run({ request: makeRequest(body), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    const parts = await readParts(result.stream);
    expect(parts.length).toBeGreaterThan(0);
    expect(fakes.appendTurn).not.toHaveBeenCalled();
  });

  it('does not persist without a valid turn id', async () => {
    const { deps, fakes } = makeDeps();
    const body = { ...HISTORY_BODY };
    delete (body as Record<string, unknown>).turnId;
    const result = await run({ request: makeRequest(body), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await readParts(result.stream);
    expect(fakes.appendTurn).not.toHaveBeenCalled();
  });
});

describe('chatTurn guardrail toggle and judge sampling (P4)', () => {
  function agenticBody(): Record<string, unknown> {
    return {
      turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'what is the policy?' }] }],
    };
  }

  it('keeps the blocking wall with ticket offer for a true empty retrieval', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () =>
        ok(agenticOk({ chunks: [], resultQuery: null, outOfDomain: true, isEmpty: true, resultState: 'no_match' })),
      ),
      hallucinationGrader: () => async () => 'yes' as const,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    const guardrail = parts.find((p) => (p as { type: string }).type === 'data-guardrail') as {
      data: Record<string, unknown>;
    };
    expect(guardrail.data).toEqual({ outOfDomain: true, offerTicket: true });
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('skips runHallucinationCheck entirely when hallucinationCheckEnabled is off', async () => {
    const grader = vi.fn(async () => 'no' as const);
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic', hallucinationCheckEnabled: false }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      hallucinationGrader: () => grader,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    expect(grader).not.toHaveBeenCalled();
    expect(parts.some((p) => (p as { type: string }).type === 'data-guardrail')).toBe(false);
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('treats a hallucination grader infra failure as pass (fail-open): no banner, answer cached', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      hallucinationGrader: () =>
        vi.fn(async () => {
          throw new Error('grade model down');
        }),
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    expect(parts.some((p) => (p as { type: string }).type === 'data-guardrail')).toBe(false);
    expect(fakes.answerCache.set).toHaveBeenCalledTimes(1);
  });

  it('still offers a ticket on an explicit grounded:no', async () => {
    const { deps } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      hallucinationGrader: () => async () => 'no' as const,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    const parts = await readParts(result.stream);
    const guardrails = parts.filter((p) => (p as { type: string }).type === 'data-guardrail') as Array<{
      data: Record<string, unknown>;
    }>;
    expect(guardrails.at(-1)?.data).toEqual({ outOfDomain: false, offerTicket: true });
  });

  it('enqueues the quality judge through the injected scheduler when sampled', async () => {
    const qualityJudge = vi.fn(
      async (ctx: { question: string; snippets: string[]; documents: string; answer: string; turnId: string }) => {
        void ctx;
        return undefined;
      },
    );
    const judgeScheduler = vi.fn((task: () => Promise<void>) => void task());
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic', judgeSampleRate: 1 }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      hallucinationGrader: () => async () => 'yes' as const,
      judgeScheduler,
      qualityJudge,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    await readParts(result.stream);
    expect(judgeScheduler).toHaveBeenCalledTimes(1);
    expect(qualityJudge).toHaveBeenCalledTimes(1);
    expect(qualityJudge.mock.calls[0]![0]).toEqual({
      question: 'what is the policy?',
      snippets: ['The dental plan covers two cleanings per year.'],
      documents: 'The dental plan covers two cleanings per year.',
      answer: 'Hello world',
      turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    expect(fakes.answerCache.set).toHaveBeenCalledTimes(1);
  });

  it('never enqueues the judge when the sample rate suppresses it or citations are absent', async () => {
    const qualityJudge = vi.fn(async () => undefined);
    const judgeScheduler = vi.fn();
    const { deps } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic', judgeSampleRate: 0 }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      hallucinationGrader: () => async () => 'yes' as const,
      judgeScheduler,
      qualityJudge,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    await readParts(result.stream);
    expect(judgeScheduler).not.toHaveBeenCalled();

    const deps2 = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic', judgeSampleRate: 1 }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      judgeScheduler,
      qualityJudge,
    }).deps;
    const result2 = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps2);
    if (result2.kind !== 'stream') throw new Error('expected stream');
    closeLlm();
    await readParts(result2.stream);
    expect(judgeScheduler).not.toHaveBeenCalled();
  });

  it('skips the judge when captureQueryText is disabled (privacy)', async () => {
    const qualityJudge = vi.fn(async () => undefined);
    const judgeScheduler = vi.fn();
    const { deps } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic', judgeSampleRate: 1, captureQueryText: false }),
      agenticSearch: vi.fn(async () => ok(agenticOk())),
      judgeScheduler,
      qualityJudge,
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(agenticBody()), userId: 'user_test' }, deps);
    if (result.kind !== 'stream') throw new Error('expected stream');
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    closeLlm();
    await readParts(result.stream);
    expect(judgeScheduler).not.toHaveBeenCalled();
    expect(qualityJudge).not.toHaveBeenCalled();
  });
});

describe('§T6 soft turn deadline', () => {
  it('arms an immediately expiring signal when the soft budget is already exhausted', async () => {
    const dateNow = vi.spyOn(Date, 'now');
    dateNow.mockReturnValueOnce(1_000).mockReturnValue(1_100);
    let timeoutMs: number | undefined;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      timeoutMs = delay;
      return new AbortController().signal;
    });
    try {
      const { deps } = makeDeps();
      deps.turnSoftDeadlineMs = 40;
      const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
      expect(result.kind).toBe('stream');
      expect(timeoutMs).toBe(0);
    } finally {
      timeout.mockRestore();
      dateNow.mockRestore();
    }
  });

  it('ends a slow generation with graceful guardrail + notice, skipping cache and judge', async () => {
    streamTextMock.mockImplementation((opts: { abortSignal?: AbortSignal }) => ({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            opts?.abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }) as Readonly<unknown> as never,
      text: Promise.resolve(''),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    }));
    const { deps } = makeDeps();
    deps.turnSoftDeadlineMs = 40;
    deps.judgeMaxWallMs = 1;
    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'slow question' }] }],
      }),
    });
    const res = await run({ request, userId: 'user_test' }, deps);
    expect(res.kind).toBe('stream');
    const parts = await readParts((res as { stream: ReadableStream }).stream);

    const guardrail = parts.find(
      (p) => (p as { type?: string }).type === 'data-guardrail',
    ) as { data: { message: string; notice: boolean; offerTicket: boolean } } | undefined;
    expect(guardrail?.data.message).toContain('took too long');
    expect(guardrail?.data.notice).toBe(true);
    expect(guardrail?.data.offerTicket).toBe(false);
    expect(
      parts.some(
        (p) => (p as { type?: string }).type === 'text-delta' && String((p as { delta?: string }).delta).includes('Sorry'),
      ),
    ).toBe(true);

    expect(deps.eventSink.record).toHaveBeenCalledTimes(1);
    const event = (deps.eventSink.record as unknown as Mock).mock.calls[0]![0] as {
      meta: Record<string, unknown>;
      hallucinationBlocked: boolean;
    };
    expect(event.meta).toMatchObject({
      fallbackReason: 'turn_deadline',
    });
    expect(event.meta).not.toHaveProperty('resultState');
    expect(event.meta).not.toHaveProperty('degraded');
    expect(event.hallucinationBlocked).toBe(false);
    expect(deps.answerCache.set).not.toHaveBeenCalled();
  });

  it('never arms the guardian on fast turns (no deadline parts)', async () => {
    const res = await run(
      {
        request: new Request('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
          }),
        }),
        userId: 'user_test',
      },
      makeDeps().deps,
    );
    expect(res.kind).toBe('stream');
    const parts = await readParts((res as { stream: ReadableStream }).stream);
    expect(parts.some((p) => (p as { type?: string }).type === 'data-guardrail')).toBe(false);
    expect(parts.some((p) => String((p as { delta?: string }).delta).includes('Sorry'))).toBe(false);
  });
});

describe('chatTurn tool-catalog rollback (WP-3 B1/B3)', () => {
  const FLAG = 'TOOL_CATALOG_ENABLED';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[FLAG];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  });

  it('uses the same new ticket contract and denied semantics with the catalog disabled', async () => {
    process.env[FLAG] = '0';
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const created = (await captured.current?.createKnowledgeTicket?.execute(
      ticketArgs({ question: 'Rollback contract check' }),
    )) as { ticketId: string; status: string };
    expect(created.status).toBe('created');
    expect(fakes.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_test',
        issue: expect.stringContaining('Question: Rollback contract check'),
      }),
    );
    const second = (await captured.current?.createKnowledgeTicket?.execute(
      ticketArgs({ question: 'second' }),
    )) as { ticketId: null; status: string; message?: string };
    closeLlm();
    await readParts(result.stream);
    expect(second).toMatchObject({ ticketId: null, status: 'denied' });
    expect(String(second.message)).toContain('already created');
  });

  it('denies ticket writes without explicit intent even with the catalog disabled', async () => {
    process.env[FLAG] = '0';
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const denied = (await captured.current?.createKnowledgeTicket?.execute(
      ticketArgs({ question: 'no intent' }),
    )) as { ticketId: null; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(denied).toMatchObject({ ticketId: null, status: 'denied' });
    expect(fakes.createTicket).not.toHaveBeenCalled();
  });

  it('returns error (not throw) when identity lookup fails with the catalog disabled', async () => {
    process.env[FLAG] = '0';
    const { deps } = makeDeps({
      userResolver: (async () => {
        throw new Error('identity down');
      }) as unknown as ChatTurnDeps['userResolver'],
    });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(TICKET_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const output = (await captured.current?.createKnowledgeTicket?.execute(
      ticketArgs({ question: 'identity failure' }),
    )) as { ticketId: null; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(output).toMatchObject({ ticketId: null, status: 'error' });
  });

  it('preserves search result contracts with the catalog disabled', async () => {
    process.env[FLAG] = '0';
    const { deps } = makeDeps();
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const output = (await captured.current?.searchDocumentation?.execute({ query: 'policy' })) as {
      sets: Array<{ kind: string; subquestionId: string }>;
      callId: string;
    };
    expect(output.sets[0]?.kind).toBe('results');
    expect(output.sets[0]?.subquestionId).toBe('sq-1');
    expect(typeof output.callId).toBe('string');
  });
});
