import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { err, ok, ExternalServiceError } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk } from '../../rag/search';
import { chatTurn, type ChatTurnDeps, type ChatTurnRequest, type ChatTurnResult } from '../chat-turn';

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
  similarity: 0.91,
};

const CHUNK2: RetrievedChunk = {
  ...CHUNK,
  id: 2,
  content: 'Submit claims via the HR portal.',
  similarity: 0.62,
};

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
    rerankerProvider: 'cosine',
    gradeModel: undefined,
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
  const searchChunks = vi.fn(async () => ok([CHUNK, CHUNK2]));
  const agenticSearch = vi.fn(async () =>
    ok({ chunks: [CHUNK], rewrittenQuery: 'rewritten', outOfDomain: false }),
  );
  const answerCache = {
    get: vi.fn(async () => null as string | null),
    set: vi.fn<(key: string, value: string, ttlSec: number) => Promise<void>>(async () => undefined),
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
    answerCacheKey: overrides.answerCacheKey ?? answerCacheKey,
    rateLimit: overrides.rateLimit ?? rateLimit,
    createTicket: overrides.createTicket ?? createTicket,
    userResolver: overrides.userResolver ?? userResolver,
    eventSink: overrides.eventSink ?? { record, flush },
    historySink: overrides.historySink ?? { appendTurn },
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

const BASIC_BODY = {
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

type CapturedTools = {
  searchDocumentation?: { execute: (args: { query: string; limit?: number }) => Promise<unknown> };
  createKnowledgeTicket?: { execute: (args: { name: string; email: string; issue: string }) => Promise<unknown> };
};

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
    const payload = JSON.parse(value) as { v: number; text: string; citations: Array<{ id: number; snippet: string }> };
    expect(payload.v).toBe(1);
    expect(payload.text).toBe('freshly generated answer');
    expect(payload.citations.map((c) => c.id)).toEqual([1, 2]);
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
    expect(ctx.fingerprint).toContain('"promptVersion":3');
  });

  it('does not cache an out-of-domain answer', async () => {
    const { deps, fakes } = makeDeps({
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      agenticSearch: vi.fn(async () => ok({ chunks: [], rewrittenQuery: '', outOfDomain: true })),
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
      data: { similarity: number; snippet: string };
    }>;
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.data.similarity)).toEqual([0.91, 0.62]);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.citationCount).toBe(2);
    expect((event?.meta as Record<string, unknown>)?.documentIds).toEqual([10]);
  });

  it('dedupes citations that share a chunk id', async () => {
    const { deps, fakes } = makeDeps();
    fakes.searchChunks.mockResolvedValue(ok([CHUNK]) as never);
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.searchDocumentation?.execute({ query: 'q' });
    await captured.current?.searchDocumentation?.execute({ query: 'q again' });
    closeLlm();
    const parts = await readParts(result.stream);
    const citations = parts.filter((p) => (p as { type: string }).type === 'data-citation');
    expect(citations).toHaveLength(1);
  });

  it('caps tool content at 800 chars with an ellipsis, wrapped in untrusted reference framing', async () => {
    const { deps, fakes } = makeDeps();
    fakes.searchChunks.mockResolvedValueOnce(ok([{ ...CHUNK, content: 'x'.repeat(2000) }]) as never);
    const { captured } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.searchDocumentation?.execute({ query: 'q' })) as Array<{
      content: string;
    }>;
    expect(out[0]?.content).toBe(
      `<reference source="${CHUNK.source}">\n${'x'.repeat(800)}\u2026\n</reference>`,
    );
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
    expect(fakes.agenticSearch).toHaveBeenCalledWith(fakes.cfg, 'vague');
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
    expect(fakes.searchChunks).toHaveBeenCalledWith(fakes.cfg, 'plain', { limit: undefined });
    expect(fakes.agenticSearch).not.toHaveBeenCalled();
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
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.createKnowledgeTicket?.execute({
      name: 'Hallucinated Name',
      email: 'hallucinated@example.com',
      issue: '  Cannot reset my password.\u0000  ',
    })) as { ticketId: string; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(out.status).toBe('created');
    expect(out.ticketId).toBe('TKT-abcdef12');
    expect(fakes.createTicket).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'Real Person',
      email: 'real@example.com',
      issue: 'Cannot reset my password.',
    });
    expect(fakes.userResolver).toHaveBeenCalledTimes(1);
    const event = fakes.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.ticketCreated).toBe(true);
    expect((event?.meta as Record<string, unknown>)?.ticketId).toBe('TKT-abcdef12');
  });

  it('does not cache a turn that opened a knowledge ticket', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.createKnowledgeTicket?.execute({
      name: 'A',
      email: 'a@a.com',
      issue: 'please open a ticket',
    });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.answerCache.set).not.toHaveBeenCalled();
  });

  it('returns an error status when createTicket fails', async () => {
    const { deps, fakes } = makeDeps();
    fakes.createTicket.mockResolvedValueOnce(err(new ExternalServiceError('db down')) as never);
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = (await captured.current?.createKnowledgeTicket?.execute({
      name: 'A',
      email: 'a@a.com',
      issue: 'my issue',
    })) as { ticketId: null; status: string };
    closeLlm();
    await readParts(result.stream);
    expect(out).toEqual({ ticketId: null, status: 'error' });
  });

  it('blocks a second ticket creation in the same turn', async () => {
    const { deps, fakes } = makeDeps();
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const first = await captured.current?.createKnowledgeTicket?.execute({
      name: 'A',
      email: 'a@a.com',
      issue: 'first ticket',
    });
    const second = await captured.current?.createKnowledgeTicket?.execute({
      name: 'B',
      email: 'b@b.com',
      issue: 'second ticket',
    });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ ticketId: 'TKT-abcdef12', status: 'created' });
    expect(second).toMatchObject({ ticketId: null, status: 'error' });
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
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const out = await captured.current?.createKnowledgeTicket?.execute({
      name: 'A',
      email: 'a@a.com',
      issue: 'blocked by rate limit',
    });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ticketId: null, status: 'error' });
    expect((out as { message?: string }).message).toContain('rate limited');
    expect(fakes.rateLimit.check).toHaveBeenCalledWith('ticket:user_test', { limit: 1, windowMs: 300_000 });
  });

  it('falls back to Unknown / synthetic email when the resolver has no profile', async () => {
    const { deps, fakes } = makeDeps();
    fakes.userResolver.mockResolvedValueOnce({ userId: 'user_test' });
    const { captured, closeLlm } = captureTools();
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await captured.current?.createKnowledgeTicket?.execute({ name: 'A', email: 'a@a.com', issue: 'x' });
    closeLlm();
    await readParts(result.stream);
    expect(fakes.createTicket).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'User',
      email: 'user_test@clerk.user',
      issue: 'x',
    });
  });

  it('pre-fetches chunks into the system prompt on the first turn when enabled', async () => {
    const { deps } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    const opts = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(opts.system).toMatch(/Pre-fetched Reference Data/);
    expect(opts.system).toContain('The dental plan covers two cleanings per year.');
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

  it('recovers when the pre-fetch fails and still generates', async () => {
    const { deps, fakes } = makeDeps({ cfg: makeCfg({ prefetchFirstTurn: true }) });
    fakes.searchChunks.mockResolvedValueOnce(err(new ExternalServiceError('db down')) as never);
    const result = await run({ request: makeRequest(BASIC_BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const opts = streamTextMock.mock.calls[0]?.[0] as { system: string };
    expect(opts.system).not.toMatch(/Pre-fetched Reference Data/);
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
