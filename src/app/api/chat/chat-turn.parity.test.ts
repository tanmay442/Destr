import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '@app/domain';
import type { Composition } from '@/composition';

const { searchValue, streamTextImpl, createTicketMock } = vi.hoisted(() => ({
  searchValue: [
    { content: 'The dental plan covers two cleanings per year.', similarity: 0.91 },
    { content: 'Submit claims via the HR portal.', similarity: 0.62 },
  ],
  streamTextImpl: vi.fn(),
  createTicketMock: vi.fn(),
}));

const { authMock, rateLimitResult } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitResult: { ok: true, remaining: 29, resetMs: 60_000 } as {
    ok: boolean;
    remaining?: number;
    resetMs?: number;
    retryAfterMs?: number;
  },
}));

const { currentUserMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
}));

const { assertSameOriginMock } = vi.hoisted(() => ({
  assertSameOriginMock: (req: Request) => {
    const origin = req.headers.get('origin');
    if (!origin) return null;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return new Response('Forbidden', { status: 403 });
    const reqHost = req.headers.get('host');
    if (reqHost && originHost !== reqHost) return new Response('Forbidden', { status: 403 });
    return null;
  },
}));

const { appConfigMock } = vi.hoisted(() => ({
  appConfigMock: {
    prefetchFirstTurn: false,
    orgName: 'Test Corp',
    audience: 'test customers',
    agentPersona: { name: 'Destr', tone: 'friendly' as const },
    outOfScopeTopics: [],
    branding: { title: 'Destr', description: '' },
    seedDocsDir: './documents',
    adminEmails: [],
    customInstructions: undefined,
  },
}));

vi.mock('@/lib/config', () => ({
  appConfig: appConfigMock,
}));

const { retrievalConfig } = vi.hoisted(() => ({
  retrievalConfig: {
    retrievalMode: 'normal' as 'agentic' | 'normal',
    retrievalModeRolloutPercent: 100,
    agentStepBudget: 8,
    agenticRetrieveLimit: 10,
    agenticMaxRetries: 1,
    similarityThreshold: 0.5,
    hybridEnabled: true,
    agenticQueryRewriteEnabled: true,
    agenticChunkGradingEnabled: true,
    hallucinationCheckEnabled: true,
    rerankerProvider: 'cosine' as const,
    gradeModel: undefined as string | undefined,
    answerCacheEnabled: true,
    answerCacheTtlSec: 3600,
    captureQueryText: true,
  },
}));

vi.mock('@/lib/config/runtime', () => ({
  getRuntimeConfig: vi.fn(async () => ({ ...appConfigMock, ...retrievalConfig })),
}));

const { graderHolder } = vi.hoisted(() => ({
  graderHolder: {
    fn: null as null | ((documents: string, generation: string) => Promise<'yes' | 'no'>),
  },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
  currentUser: currentUserMock,
}));

type MockComposition = {
  rateLimit: (key: string, opts: unknown) => typeof rateLimitResult;
  searchChunks: ReturnType<typeof vi.fn>;
  createTicket: ReturnType<typeof vi.fn>;
  getChatModel: ReturnType<typeof vi.fn>;
  getEmbeddingModel: ReturnType<typeof vi.fn>;
  getEmbeddingModelId: ReturnType<typeof vi.fn>;
  answerCacheKey: ReturnType<typeof vi.fn>;
  answerCache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  logTicketEvent: ReturnType<typeof vi.fn>;
  agenticSearch: (
    cfg: unknown,
    query: string,
  ) => Promise<{
    ok: boolean;
    value: { chunks: unknown[]; rewrittenQuery: string; outOfDomain: boolean };
  }>;
  getHallucinationGrader: (
    cfg: unknown,
  ) => ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  chatEventBatcher: {
    record: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    updateEventMeta: ReturnType<typeof vi.fn>;
    patchMeta: ReturnType<typeof vi.fn>;
  };
  appendChatTurn: ReturnType<typeof vi.fn>;
};

const { compositionMock } = vi.hoisted<{ compositionMock: MockComposition }>(() => ({
  compositionMock: {
    rateLimit: () => rateLimitResult,
    searchChunks: vi.fn(async () => ok(searchValue) as never),
    createTicket: createTicketMock,
    getChatModel: vi.fn(() => ({ modelId: 'mock' })),
    getEmbeddingModel: vi.fn(() => ({ modelId: 'mock-embed' })),
    getEmbeddingModelId: vi.fn(() => 'mock-embed'),
    answerCacheKey: vi.fn((query: string, opts?: { userId?: string; fingerprint?: string }) =>
      `rag:answer:${Buffer.from(query + (opts?.userId ?? '') + (opts?.fingerprint ?? '')).toString('hex').slice(0, 32)}`,
    ),
    answerCache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    },
    logTicketEvent: vi.fn(),
    agenticSearch: vi.fn(async () => ok({ chunks: [], rewrittenQuery: '', outOfDomain: false }) as never),
    getHallucinationGrader: vi.fn(() => graderHolder.fn),
    chatEventBatcher: {
      record: vi.fn(),
      flush: vi.fn(async () => undefined),
      updateEventMeta: vi.fn(async () => true),
      patchMeta: vi.fn(),
    },
    appendChatTurn: vi.fn(async () => ({ ok: true, value: { conversationId: 'conv-1' } }) as never),
  },
}));

const { judgeRelevanceMock, judgeFaithfulnessMock } = vi.hoisted(() => ({
  judgeRelevanceMock: vi.fn(async () => ({ score: 0.8, reason: 'relevant' })),
  judgeFaithfulnessMock: vi.fn(async () => ({ score: 0.9, citationPrecision: 0.85, reason: 'grounded' })),
}));

vi.mock('@/composition', () => ({
  getComposition: () => compositionMock as unknown as Composition,
  appConfig: appConfigMock,
  assertSameOrigin: assertSameOriginMock,
  TRACE_ENABLED: false,
  judgeRelevance: judgeRelevanceMock,
  judgeFaithfulness: judgeFaithfulnessMock,
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    streamText: streamTextImpl,
    tool: actual.tool,
  };
});

// Run `after` tasks inline so fire-and-forget judge work settles within the test.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
  after: (task: () => void) => {
    task();
  },
}));

import * as appHandler from './route';

/** Full §A3 AgenticResult shape for composition.agenticSearch mocks. */
function agenticResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunks: [
      { content: 'doc', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null },
    ],
    rewrittenQuery: 'rewritten',
    outOfDomain: false,
    isEmpty: false,
    degraded: false,
    fallbackReason: null,
    resultState: 'ok',
    gradingUnavailable: false,
    ...overrides,
  };
}

const BASIC_BODY = JSON.stringify({
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
});

type ScriptedTools = {
  searchDocumentation?: { execute: (args: { query: string; limit?: number }) => Promise<unknown> };
  createKnowledgeTicket?: {
    execute: (args: { name: string; email: string; issue: string }) => Promise<unknown>;
  };
};

const scripted: Array<{
  tools: ScriptedTools | undefined;
  controller: ReadableStreamDefaultController<unknown> | null;
  pending: Promise<unknown>;
  toolTrace: { toolCallId: string; toolName: string; input: unknown } | undefined;
}> = [];

function scriptStream(opts: {
  text?: string;
  drive?: (tools: ScriptedTools | undefined) => unknown;
  toolTrace?: { toolCallId: string; toolName: string; input: unknown };
} = {}): void {
  streamTextImpl.mockImplementation((o: { tools?: unknown }) => {
    const entry: (typeof scripted)[number] = {
      tools: o?.tools as ScriptedTools | undefined,
      controller: null,
      pending: Promise.resolve(),
      toolTrace: opts.toolTrace,
    };
    scripted.push(entry);
    entry.pending = Promise.resolve().then(() => opts.drive?.(entry.tools));
    const stream = new ReadableStream<unknown>({
      start(controller) {
        entry.controller = controller;
        controller.enqueue({ type: 'start', messageId: 'message-1' });
        controller.enqueue({ type: 'text-start', id: 'intro' });
        controller.enqueue({ type: 'text-delta', id: 'intro', delta: 'Hello ' });
        controller.enqueue({ type: 'text-delta', id: 'intro', delta: 'world' });
        controller.enqueue({ type: 'text-end', id: 'intro' });
        if (entry.toolTrace) {
          controller.enqueue({
            type: 'tool-input-start',
            toolCallId: entry.toolTrace.toolCallId,
            toolName: entry.toolTrace.toolName,
          });
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: entry.toolTrace.toolCallId,
            toolName: entry.toolTrace.toolName,
            input: entry.toolTrace.input,
          });
        }
      },
    });
    return {
      toUIMessageStream: () => stream,
      text: Promise.resolve(opts.text ?? 'Hello world'),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
  });
}

async function finishScriptedStreams(): Promise<void> {
  for (const entry of scripted) {
    const output = await entry.pending;
    if (entry.toolTrace) {
      entry.controller!.enqueue({
        type: 'tool-output-available',
        toolCallId: entry.toolTrace.toolCallId,
        output,
      });
      entry.controller!.enqueue({ type: 'text-start', id: 'final' });
      entry.controller!.enqueue({ type: 'text-delta', id: 'final', delta: ' Final.' });
      entry.controller!.enqueue({ type: 'text-end', id: 'final' });
    }
    entry.controller!.enqueue({ type: 'finish', finishReason: 'stop' });
    entry.controller!.close();
  }
}

async function post(
  useCase: boolean,
  body: string = BASIC_BODY,
  signal?: AbortSignal,
): Promise<Response> {
  vi.stubEnv('CHAT_TURN_USE_CASE', useCase ? '1' : '');
  return appHandler.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(signal ? { signal } : {}),
    }),
  );
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function lastRecordedEvent(): Record<string, unknown> {
  const calls = compositionMock.chatEventBatcher.record.mock.calls;
  return (calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
}

function deterministicEvent(event: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...event };
  delete rest.totalMs;
  delete rest.generateMs;
  delete rest.retrieveMs;
  return rest;
}

beforeEach(() => {
  streamTextImpl.mockReset();
  authMock.mockReset();
  currentUserMock.mockReset();
  createTicketMock.mockReset();
  scripted.length = 0;
  authMock.mockResolvedValue({ userId: 'user_test' });
  currentUserMock.mockResolvedValue({
    id: 'user_test',
    emailAddresses: [{ emailAddress: 'real@example.com' }],
    fullName: 'Real Person',
    firstName: 'Real',
    username: 'realperson',
  });
  createTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-abcd1234', status: 'created' }) as never);
  rateLimitResult.ok = true;
  rateLimitResult.remaining = 29;
  rateLimitResult.resetMs = 60_000;
  delete (rateLimitResult as { retryAfterMs?: number }).retryAfterMs;
  appConfigMock.prefetchFirstTurn = false;
  retrievalConfig.retrievalMode = 'normal';
  retrievalConfig.retrievalModeRolloutPercent = 100;
  compositionMock.agenticSearch = vi.fn(async () => ok(agenticResult({ chunks: [] })) as never);
  compositionMock.searchChunks.mockReset();
  compositionMock.searchChunks.mockResolvedValue(ok(searchValue) as never);
  compositionMock.answerCache.get.mockReset();
  compositionMock.answerCache.get.mockResolvedValue(null);
  compositionMock.answerCache.set.mockClear();
  graderHolder.fn = null;
  compositionMock.chatEventBatcher.record.mockClear();
  compositionMock.chatEventBatcher.flush.mockClear();
  compositionMock.chatEventBatcher.updateEventMeta.mockClear();
  compositionMock.chatEventBatcher.patchMeta.mockClear();
  compositionMock.appendChatTurn.mockClear();
  compositionMock.getChatModel.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/api/chat R4 side-by-side parity (legacy inline vs chatTurn use case)', () => {
  it('401 Unauthorized for a missing session', async () => {
    authMock.mockResolvedValue({ userId: null });
    const legacy = await post(false);
    const useCase = await post(true);
    expect(useCase.status).toBe(legacy.status);
    expect(await drain(useCase)).toBe(await drain(legacy));
  });

  it('429 Too Many Requests with identical Retry-After', async () => {
    rateLimitResult.ok = false;
    (rateLimitResult as { retryAfterMs?: number }).retryAfterMs = 5_000;
    const legacy = await post(false);
    const useCase = await post(true);
    expect(useCase.status).toBe(legacy.status);
    expect(useCase.status).toBe(429);
    expect(useCase.headers.get('retry-after')).toBe(legacy.headers.get('retry-after'));
    expect(useCase.headers.get('retry-after')).toBe('5');
    expect(await drain(useCase)).toBe(await drain(legacy));
  });

  it('does not resolve a chat model before rate limiting or request validation', async () => {
    rateLimitResult.ok = false;
    await post(false);
    await post(true);
    expect(compositionMock.getChatModel).not.toHaveBeenCalled();

    rateLimitResult.ok = true;
    const badBody = JSON.stringify({ messages: 'nope' });
    await post(false, badBody);
    await post(true, badBody);
    expect(compositionMock.getChatModel).not.toHaveBeenCalled();
  });

  it('400 invalid_request with identical issues payload', async () => {
    const badBody = JSON.stringify({ messages: 'nope' });
    const legacy = await post(false, badBody);
    const useCase = await post(true, badBody);
    expect(useCase.status).toBe(legacy.status);
    expect(useCase.status).toBe(400);
    expect(JSON.parse(await drain(useCase))).toEqual(JSON.parse(await drain(legacy)));
  });

  it('413 Payload too large when the parsed body exceeds the cap', async () => {
    const huge = JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(1_100_000) }] }] });
    const legacy = await post(false, huge);
    const useCase = await post(true, huge);
    expect(useCase.status).toBe(legacy.status);
    expect(useCase.status).toBe(413);
    expect(await drain(useCase)).toBe(await drain(legacy));
  });

  it('streams an identical basic turn (no tools)', async () => {
    scriptStream();
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCase.status).toBe(200);
    expect(useCaseText).toBe(legacyText);
  });

  it('propagates abort signals to both orchestration paths', async () => {
    scriptStream();
    const legacyAbort = new AbortController();
    const useCaseAbort = new AbortController();
    const legacy = await post(false, BASIC_BODY, legacyAbort.signal);
    const useCase = await post(true, BASIC_BODY, useCaseAbort.signal);
    legacyAbort.abort();
    useCaseAbort.abort();
    const calls = streamTextImpl.mock.calls.map((call) => call[0] as { abortSignal: AbortSignal });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.abortSignal.aborted).toBe(true);
    expect(calls[1]!.abortSignal.aborted).toBe(true);
    await finishScriptedStreams();
    expect(await drain(useCase)).toBe(await drain(legacy));
  });

  it('streams an identical tool-search turn with citations', async () => {
    scriptStream({
      toolTrace: { toolCallId: 'search-1', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'dental coverage' });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('data-citation');
    expect(compositionMock.searchChunks).toHaveBeenCalledTimes(2);
    const [firstArgs, secondArgs] = compositionMock.searchChunks.mock.calls;
    expect(secondArgs).toEqual(firstArgs);
  });

  it('persists identical chat history on both paths (including retry)', async () => {
    const historyBody = JSON.stringify({
      turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      conversationId: 'a0000000-0000-4000-8000-000000000001',
      retry: true,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    });
    scriptStream({
      toolTrace: { toolCallId: 'search-hist', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'dental coverage' });
      },
    });
    const legacy = await post(false, historyBody);
    const useCase = await post(true, historyBody);
    await finishScriptedStreams();
    await Promise.all([drain(legacy), drain(useCase)]);
    const calls = compositionMock.appendChatTurn.mock.calls;
    expect(calls).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(calls[1]![0]))).toEqual(JSON.parse(JSON.stringify(calls[0]![0])));
    const persisted = calls[0]![0] as Record<string, unknown>;
    expect(persisted.conversationId).toBe('a0000000-0000-4000-8000-000000000001');
    expect(persisted.turnId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(persisted.retryOfMessageId).toBe('m1');
  });

  it('answers without persisting when conversationId is absent on both paths', async () => {
    const historyBody = JSON.stringify({
      turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    });
    scriptStream({
      toolTrace: { toolCallId: 'search-noid', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'dental coverage' });
      },
    });
    const legacy = await post(false, historyBody);
    const useCase = await post(true, historyBody);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(compositionMock.appendChatTurn).not.toHaveBeenCalled();
  });

  it('records identical chat events (excluding timing fields)', async () => {
    scriptStream({
      toolTrace: { toolCallId: 'search-2', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'dental coverage' });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    await Promise.all([drain(legacy), drain(useCase)]);
    const calls = compositionMock.chatEventBatcher.record.mock.calls;
    expect(deterministicEvent(lastRecordedEvent())).toEqual(deterministicEvent(calls.at(-2)?.[0] as Record<string, unknown>));
  });

  it('streams an identical cached answer on a cache hit', async () => {
    compositionMock.answerCache.get.mockResolvedValue('Cached answer body');
    const legacy = await post(false);
    const useCase = await post(true);
    expect(streamTextImpl).not.toHaveBeenCalled();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCase.status).toBe(legacy.status);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('Cached answer body');
  });

  it('writes the identical cache entry on a grounded first turn', async () => {
    scriptStream({
      text: 'freshly generated answer',
      toolTrace: { toolCallId: 'search-cache', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => tools?.searchDocumentation?.execute({ query: 'dental coverage' }),
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    await Promise.all([drain(legacy), drain(useCase)]);
    const setCalls = compositionMock.answerCache.set.mock.calls;
    expect(setCalls).toHaveLength(2);
    expect(setCalls[1]).toEqual(setCalls[0]);
  });

  it('does not write the cache for an out-of-domain turn (identical streams)', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    compositionMock.agenticSearch = vi.fn(async () =>
      ok({ chunks: [], rewrittenQuery: 'rewritten', outOfDomain: true }) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    scriptStream({
      toolTrace: { toolCallId: 'search-3', toolName: 'searchDocumentation', input: { query: 'where is my refund?' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'where is my refund?' });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('data-guardrail');
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('streams an identical guardrail when the grader blocks', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    compositionMock.agenticSearch = vi.fn(async () =>
      ok({
        chunks: [{ content: 'doc', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null }],
        rewrittenQuery: 'rewritten',
        outOfDomain: false,
      }) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    scriptStream({
      toolTrace: { toolCallId: 'search-4', toolName: 'searchDocumentation', input: { query: 'what is the policy?' } },
      drive: (tools) => {
        return tools?.searchDocumentation?.execute({ query: 'what is the policy?' });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('data-guardrail');
  });

  it('resolves the ticket with the identical user profile and identical stream', async () => {
    scriptStream({
      toolTrace: { toolCallId: 'ticket-1', toolName: 'createKnowledgeTicket', input: { name: 'Ignored Name', email: 'ignored@example.com', issue: 'Need a human to fix my account.' } },
      drive: (tools) => {
        return tools?.createKnowledgeTicket?.execute({
          name: 'Ignored Name',
          email: 'ignored@example.com',
          issue: '  Need a human to fix my account.  ',
        });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    const ticketCalls = createTicketMock.mock.calls;
    expect(ticketCalls).toHaveLength(2);
    expect(ticketCalls[1]).toEqual(ticketCalls[0]);
    expect(ticketCalls[0]).toEqual([
      {
        userId: 'user_test',
        name: 'Real Person',
        email: 'real@example.com',
        issue: 'Need a human to fix my account.',
      },
    ]);
  });

  it('returns an error tool status when createTicket fails (identical streams)', async () => {
    createTicketMock.mockResolvedValue(err(new Error('db down')) as never);
    scriptStream({
      toolTrace: { toolCallId: 'ticket-2', toolName: 'createKnowledgeTicket', input: { name: 'A', email: 'a@a.com', issue: 'my issue' } },
      drive: (tools) => {
        return tools?.createKnowledgeTicket?.execute({ name: 'A', email: 'a@a.com', issue: 'my issue' });
      },
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(createTicketMock).toHaveBeenCalledTimes(2);
  });

  it('pre-fetches and emits the same citations for a first turn with prefetch enabled', async () => {
    appConfigMock.prefetchFirstTurn = true;
    scriptStream();
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('data-citation');
    expect(compositionMock.searchChunks).toHaveBeenCalledTimes(2);
  });
});

describe('/api/chat P4 parity — degraded fallback, guardrail toggle and judge sampling', () => {
  function scriptAgenticSearch(overrides: Record<string, unknown>): void {
    compositionMock.agenticSearch = vi.fn(async () => ok(agenticResult(overrides)) as never);
  }

  it('degraded top-4 fallback: identical soft-banner streams, identical events, no cache write', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    scriptAgenticSearch({ degraded: true, fallbackReason: 'grader_unavailable', resultState: 'degraded', gradingUnavailable: true });
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    scriptStream({
      toolTrace: { toolCallId: 'search-deg', toolName: 'searchDocumentation', input: { query: 'obscure question' } },
      drive: (tools) => tools?.searchDocumentation?.execute({ query: 'obscure question' }),
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    // Soft banner only — never a wall or ticket offer on either path.
    expect(useCaseText).toContain('data-guardrail');
    expect(useCaseText).toContain('Based on best-effort matches (4)');
    expect(useCaseText).not.toContain('"offerTicket":true');
    // Degraded turns are excluded from the cache on both paths.
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
    const calls = compositionMock.chatEventBatcher.record.mock.calls;
    expect(calls).toHaveLength(2);
    expect(deterministicEvent(calls[1]![0] as Record<string, unknown>)).toEqual(
      deterministicEvent(calls[0]![0] as Record<string, unknown>),
    );
    const meta = (calls[0]![0] as { meta: Record<string, unknown> }).meta;
    expect(meta).toMatchObject({
      degraded: true,
      fallbackReason: 'grader_unavailable',
      isEmpty: false,
      resultState: 'degraded',
    });
  });

  it('hallucinationCheckEnabled off: guardrail skipped and cache excluded identically on both paths', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    retrievalConfig.hallucinationCheckEnabled = false;
    try {
      scriptAgenticSearch({});
      graderHolder.fn = vi.fn(async () => 'no' as const); // would block if enabled
      scriptStream({
        toolTrace: { toolCallId: 'search-off', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
        drive: (tools) => tools?.searchDocumentation?.execute({ query: 'dental coverage' }),
      });
      const legacy = await post(false);
      const useCase = await post(true);
      await finishScriptedStreams();
      const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
      expect(useCaseText).toBe(legacyText);
      expect(useCaseText).not.toContain('data-guardrail');
      expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
      const calls = compositionMock.chatEventBatcher.record.mock.calls;
      expect(deterministicEvent(calls[1]![0] as Record<string, unknown>)).toEqual(
        deterministicEvent(calls[0]![0] as Record<string, unknown>),
      );
    } finally {
      retrievalConfig.hallucinationCheckEnabled = true;
    }
  });

  it('true empty retrieval keeps the blocking wall identically on both paths', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    scriptAgenticSearch({ chunks: [], outOfDomain: true, isEmpty: true, resultState: 'empty' });
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    scriptStream({
      toolTrace: { toolCallId: 'search-empty', toolName: 'searchDocumentation', input: { query: 'where is my refund?' } },
      drive: (tools) => tools?.searchDocumentation?.execute({ query: 'where is my refund?' }),
    });
    const legacy = await post(false);
    const useCase = await post(true);
    await finishScriptedStreams();
    const [legacyText, useCaseText] = await Promise.all([drain(legacy), drain(useCase)]);
    expect(useCaseText).toBe(legacyText);
    expect(useCaseText).toContain('"offerTicket":true');
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('sampled judges run with identical context and persist identical scores on both paths', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    scriptAgenticSearch({});
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // sample on both paths
    const judgeBody = JSON.stringify({
      turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    });
    scriptStream({
      toolTrace: { toolCallId: 'search-judge', toolName: 'searchDocumentation', input: { query: 'dental coverage' } },
      drive: (tools) => tools?.searchDocumentation?.execute({ query: 'dental coverage' }),
    });
    try {
      const legacy = await post(false, judgeBody);
      const useCase = await post(true, judgeBody);
      await finishScriptedStreams();
      await Promise.all([drain(legacy), drain(useCase)]);
      // Let the inline fire-and-forget judge chains settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const calls = compositionMock.chatEventBatcher.updateEventMeta.mock.calls;
      expect(calls).toHaveLength(2);
      const [legacyTurnId, legacyPatch] = calls[0]! as [string, { judgeScores: Record<string, unknown> }];
      const [useCaseTurnId, useCasePatch] = calls[1]! as [string, { judgeScores: Record<string, unknown> }];
      // Same explicit turn id on both paths; identical context → identical scores.
      expect(useCaseTurnId).toBe(legacyTurnId);
      const stripJudgedAt = (patch: { judgeScores: Record<string, unknown> }) => ({
        retrievalRelevance: patch.judgeScores.retrievalRelevance,
        faithfulness: patch.judgeScores.faithfulness,
        citationPrecision: patch.judgeScores.citationPrecision,
      });
      expect(stripJudgedAt(useCasePatch)).toEqual(stripJudgedAt(legacyPatch));
      expect(stripJudgedAt(legacyPatch)).toMatchObject({
        retrievalRelevance: 0.8,
        faithfulness: 0.9,
        citationPrecision: 0.85,
      });
      expect(compositionMock.chatEventBatcher.patchMeta).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });
});
