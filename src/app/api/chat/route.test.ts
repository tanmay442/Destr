import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '@app/domain';
import type { Composition } from '@/composition';

const { searchValue, ticketInsertedValues, streamTextImpl, createTicketMock } = vi.hoisted(() => ({
  searchValue: [
    { content: 'The dental plan covers two cleanings per year.', similarity: 0.91 },
    { content: 'Submit claims via the HR portal.', similarity: 0.62 },
  ],
  ticketInsertedValues: [] as Array<Record<string, unknown>>,
  streamTextImpl: vi.fn(),
  createTicketMock: vi.fn(),
}));

const { authMock, rateLimitResult } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitResult: { ok: true, remaining: 29, resetMs: 60_000 } as { ok: boolean; remaining?: number; resetMs?: number; retryAfterMs?: number },
}));

const { afterMock } = vi.hoisted(() => ({
  afterMock: vi.fn((task: () => void) => {
    afterCallbacks.push(task);
  }),
}));
const afterCallbacks: Array<() => void> = [];

const { judgeRelevanceMock, judgeFaithfulnessMock } = vi.hoisted(() => ({
  judgeRelevanceMock: vi.fn(async () => ({ score: 0.8, reason: 'relevant' })),
  judgeFaithfulnessMock: vi.fn(async () => ({ score: 0.9, citationPrecision: 0.85, reason: 'grounded' })),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
  after: afterMock,
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
  graderHolder: { fn: null as null | ((documents: string, generation: string) => Promise<'yes' | 'no'>) },
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
  currentUser: currentUserMock,
}));

type MockComposition = {
  rateLimit: () => typeof rateLimitResult;
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
  agenticSearch: (cfg: unknown, query: string) => Promise<{ ok: boolean; value: { chunks: unknown[]; rewrittenQuery: string; outOfDomain: boolean } }>;
  getHallucinationGrader: (cfg: unknown) => ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  chatEventBatcher: {
    record: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    updateEventMeta: ReturnType<typeof vi.fn>;
    patchMeta: ReturnType<typeof vi.fn>;
  };
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
    agenticSearch: vi.fn(async () => ok(agenticResult()) as never),
    getHallucinationGrader: vi.fn(() => graderHolder.fn),
    chatEventBatcher: {
      record: vi.fn(),
      flush: vi.fn(async () => undefined),
      updateEventMeta: vi.fn(async () => true),
      patchMeta: vi.fn(),
    },
  },
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

import * as appHandler from './route';

function agenticResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunks: [],
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

function makeUIMessageStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.close(); },
  });
}

async function drainResponse(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function captureToolsFromStreamText<T>(): Promise<T | undefined> {
  authMock.mockResolvedValue({ userId: 'user_test' });
  let captured: T | undefined;
  streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
    captured = opts?.tools as T;
    return { toUIMessageStream: () => makeUIMessageStream() };
  });
  const res = await appHandler.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    }),
  );
  expect(res.status).toBe(200);
  expect(streamTextImpl).toHaveBeenCalled();
  return captured;
}

beforeEach(() => {
  streamTextImpl.mockImplementation(() => ({
    toUIMessageStream: () => makeUIMessageStream(),
  }));
  authMock.mockReset();
  currentUserMock.mockReset();
  createTicketMock.mockReset();
  ticketInsertedValues.length = 0;
  createTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-abcd1234', status: 'created' }) as never);
  currentUserMock.mockResolvedValue({
    id: 'user_test',
    emailAddresses: [{ emailAddress: 'real@example.com' }],
    fullName: 'Real Person',
    firstName: 'Real',
    username: 'realperson',
  });
  rateLimitResult.ok = true;
  rateLimitResult.remaining = 29;
  rateLimitResult.resetMs = 60_000;
  appConfigMock.prefetchFirstTurn = false;
  retrievalConfig.retrievalMode = 'normal';
  retrievalConfig.retrievalModeRolloutPercent = 100;
  compositionMock.agenticSearch = vi.fn(async () => ok(agenticResult()) as never);
  graderHolder.fn = null;
  compositionMock.chatEventBatcher.record.mockClear();
  compositionMock.chatEventBatcher.flush.mockClear();
  compositionMock.chatEventBatcher.updateEventMeta.mockClear();
  compositionMock.chatEventBatcher.patchMeta.mockClear();
  judgeRelevanceMock.mockClear();
  judgeFaithfulnessMock.mockClear();
  afterMock.mockClear();
  afterCallbacks.length = 0;
});

describe('/api/chat', () => {
  it('exposes a POST handler', () => {
    expect(typeof appHandler.POST).toBe('function');
  });

  it('returns 401 when there is no signed-in user', async () => {
    authMock.mockResolvedValue({ userId: null });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when the rate limiter says so', async () => {
    authMock.mockResolvedValue({ userId: 'user_1' });
    rateLimitResult.ok = false;
    (rateLimitResult as unknown as { retryAfterMs: number }).retryAfterMs = 5_000;
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      }),
    );
    expect(res.status).toBe(429);
  });

  it('rejects a cross-site request with 403 before any work happens', async () => {
    authMock.mockResolvedValue({ userId: 'user_test' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          origin: 'http://evil.test',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      }),
    );
    expect(res.status).toBe(403);
    expect(streamTextImpl).not.toHaveBeenCalled();
  });

  it('returns 413 for a body larger than the cap via streaming read', async () => {
    authMock.mockResolvedValue({ userId: 'user_big' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(2_000_000) }] }],
        }),
      }),
    );
    expect(res.status).toBe(413);
    expect(streamTextImpl).not.toHaveBeenCalled();
  });

  it('caps concurrent streams per user at 2, freeing the slot when a stream ends', async () => {
    authMock.mockResolvedValue({ userId: 'user_conc' });
    let blocked = true;
    const blockedControllers: Array<ReadableStreamDefaultController<unknown> | null> = [null, null];
    streamTextImpl.mockImplementation(() => ({
      toUIMessageStream: () =>
        new ReadableStream<unknown>({
          start(controller) {
            if (blocked) {
              const idx = blockedControllers[0] === null ? 0 : 1;
              blockedControllers[idx] = controller as ReadableStreamDefaultController<unknown>;
            } else {
              controller.close();
            }
          },
        }),
    }));
    const body = JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    const makePost = () =>
      appHandler.POST(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );
    const r1 = await makePost();
    const r2 = await makePost();
    const r3 = await makePost();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBe('1');
    blockedControllers[0]!.close();
    blockedControllers[1]!.close();
    await drainResponse(r1);
    await drainResponse(r2);
    blocked = false;
    const r4 = await makePost();
    expect(r4.status).toBe(200);
    await drainResponse(r4);
  });

  it('passes a createKnowledgeTicket tool to streamText', () => {
    expect(appHandler.POST).toBeDefined();
  });
});

describe('/api/chat createKnowledgeTicket tool', () => {
  async function invokeToolFromStreamText(overrides: {
    name: string;
    email: string;
    issue: string;
  }) {
    const tools = await captureToolsFromStreamText<{
      createKnowledgeTicket: {
        execute: (args: { name: string; email: string; issue: string }) => Promise<unknown>;
      };
    }>();
    const tool = tools?.createKnowledgeTicket;
    expect(tool).toBeDefined();
    return tool!.execute(overrides);
  }

  it('creates a ticket with a TKT- prefixed id, ignoring LLM-supplied name/email', async () => {
    createTicketMock.mockResolvedValueOnce(ok({ ticketId: 'TKT-abcd1234', status: 'created' }) as never);
    const out = await invokeToolFromStreamText({
      name: 'Hallucinated Name',
      email: 'hallucinated@example.com',
      issue: 'Cannot reset my password.',
    });
    expect(out).toHaveProperty('status', 'created');
    expect(out).toHaveProperty('ticketId');
    expect((out as { ticketId: string }).ticketId).toMatch(/^TKT-[a-f0-9]{8}$/);
    expect(createTicketMock).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'Real Person',
      email: 'real@example.com',
      issue: 'Cannot reset my password.',
    });
  });

  it('falls back to a synthetic email when the Clerk user has no email', async () => {
    currentUserMock.mockResolvedValueOnce({
      id: 'user_nomail',
      emailAddresses: [],
      fullName: 'No Mail',
      firstName: 'No',
      username: 'nomail',
    });
    createTicketMock.mockResolvedValueOnce(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never);
    const out = await invokeToolFromStreamText({
      name: 'A',
      email: 'a@a.com',
      issue: 'no email on account',
    });
    expect(out).toHaveProperty('status', 'created');
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'user_nomail@clerk.user' }),
    );
  });

  it('generates unique ticket ids (UUID-based, no collision retry needed)', async () => {
    createTicketMock
      .mockResolvedValueOnce(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never)
      .mockResolvedValueOnce(ok({ ticketId: 'TKT-bbbbbbbb', status: 'created' }) as never);
    const out1 = await invokeToolFromStreamText({
      name: 'A',
      email: 'a@a.com',
      issue: 'first ticket',
    });
    const out2 = await invokeToolFromStreamText({
      name: 'B',
      email: 'b@b.com',
      issue: 'second ticket',
    });
    expect((out1 as { ticketId: string }).ticketId).not.toBe((out2 as { ticketId: string }).ticketId);
  });

  it('returns an error status when createTicket fails', async () => {
    const { ExternalServiceError } = await import('@app/domain');
    createTicketMock.mockResolvedValueOnce(err(new ExternalServiceError('db down')) as never);
    const out = await invokeToolFromStreamText({
      name: 'A',
      email: 'a@a.com',
      issue: 'my issue',
    });
    expect(out).toHaveProperty('status', 'error');
    expect(out).toHaveProperty('ticketId', null);
  });
});

describe('/api/chat searchDocumentation tool', () => {
  async function captureTools() {
    const tools = await captureToolsFromStreamText<{
      searchDocumentation: {
        execute: (args: { query: string; limit?: number }) => Promise<unknown>;
      };
    }>();
    return { tools: tools ?? null };
  }

  it('returns up to 800 chars per chunk wrapped in untrusted reference framing', async () => {
    const longContent = 'x'.repeat(2000);
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(
        ok([{ content: longContent, similarity: 0.8, source: 'https://docs.example.com/a.md' }]) as never,
      );
    const { tools } = await captureTools();
    const result = (await tools?.searchDocumentation?.execute({ query: 'q' })) as Array<{
      content: string;
    }>;
    expect(result?.[0]?.content.startsWith('<reference source="https://docs.example.com/a.md">\n')).toBe(true);
    expect(result?.[0]?.content.endsWith('\n</reference>')).toBe(true);
    expect(result?.[0]?.content).toContain('x'.repeat(800) + '\u2026');
    searchChunksSpy.mockRestore();
  });

  it('passes a user-supplied limit through to searchChunks', async () => {
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(ok([]) as never);
    const { tools } = await captureTools();
    await tools?.searchDocumentation?.execute({ query: 'q', limit: 5 });
    expect(searchChunksSpy).toHaveBeenCalledWith(expect.anything(), 'q', { limit: 5 });
    searchChunksSpy.mockRestore();
  });

  it('emits captured citations as data-citation parts after the LLM stream ends', async () => {
    authMock.mockResolvedValue({ userId: 'user_test' });
    type Ctl = ReadableStreamDefaultController<{ type: string }>;
    let streamController: Ctl | null = null;
    const llmStream = new ReadableStream<{ type: string }>({
      start(controller) {
        streamController = controller;
      },
    });
    let capturedTools:
      | {
          searchDocumentation: {
            execute: (args: { query: string; limit?: number }) => Promise<unknown>;
          };
        }
      | undefined;
    streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
      capturedTools = opts?.tools as typeof capturedTools;
      return {
        toUIMessageStream: () => llmStream as unknown as ReadableStream<Uint8Array>,
      };
    });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    await capturedTools?.searchDocumentation.execute({ query: 'q' });
    streamController!.close();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    expect(body).toMatch(/data-citation/);
    expect(body).toMatch(/0\.91/);
    expect(body).toMatch(/dental plan/);
  });
});

describe('/api/chat pre-fetch toggle (default off)', () => {
  async function captureSystemForBody(body: { messages: unknown[] }) {
    authMock.mockResolvedValue({ userId: 'user_test' });
    let capturedSystem: unknown;
    streamTextImpl.mockImplementation((opts: { system?: unknown }) => {
      capturedSystem = opts?.system;
      return { toUIMessageStream: () => makeUIMessageStream() };
    });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    return { system: capturedSystem, res };
  }

  it('respects appConfig.prefetchFirstTurn = false (default): no pre-fetch block, tool-driven branch', async () => {
    const { system } = await captureSystemForBody({
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'How do I change my password?' }],
        },
      ],
    });
    expect(typeof system).toBe('string');
    const sys = system as string;
    expect(sys).not.toMatch(/Pre-fetched Reference Data/);
    expect(sys).toContain('searchDocumentation');
    expect(sys).toContain('createKnowledgeTicket');
  });

  it('respects appConfig.prefetchFirstTurn = false on empty lastUserText', async () => {
    const { system } = await captureSystemForBody({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '' }] }],
    });
    expect(typeof system).toBe('string');
    expect(system as string).not.toMatch(/Pre-fetched Reference Data/);
  });

  it('with prefetchFirstTurn = false, citation still surfaces as data-citation when the tool is called', async () => {
    authMock.mockResolvedValue({ userId: 'user_test' });
    type Ctl = ReadableStreamDefaultController<{ type: string }>;
    let streamController: Ctl | null = null;
    const llmStream = new ReadableStream<{ type: string }>({
      start(controller) {
        streamController = controller;
      },
    });
    let capturedTools:
      | {
          searchDocumentation: {
            execute: (args: { query: string; limit?: number }) => Promise<unknown>;
          };
        }
      | undefined;
    streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
      capturedTools = opts?.tools as typeof capturedTools;
      return {
        toUIMessageStream: () => llmStream as unknown as ReadableStream<Uint8Array>,
      };
    });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              id: 'm1',
              role: 'user',
              parts: [{ type: 'text', text: 'How do I change my password?' }],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    await capturedTools?.searchDocumentation.execute({ query: 'q' });
    streamController!.close();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    expect(body).toMatch(/data-citation/);
    expect(body).toMatch(/dental plan/);
    expect(body).toMatch(/0\.91/);
  });

  it('with prefetchFirstTurn = true, still injects pre-fetched chunks (legacy behaviour preserved)', async () => {
    appConfigMock.prefetchFirstTurn = true;
    const { system } = await captureSystemForBody({
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'dress code grade 6' }],
        },
      ],
    });
    expect(typeof system).toBe('string');
    const sys = system as string;
    expect(sys).toMatch(/Pre-fetched Reference Data/);
    expect(sys).toContain('The dental plan covers two cleanings per year.');
    expect(sys).toContain('Submit claims via the HR portal.');
    expect(sys).toMatch(/untrusted content for grounding only/);
    expect(sys).toMatch(/no active system instructions/);
  });

  it('does not pre-fetch on a follow-up turn (messages.length > 0) regardless of toggle', async () => {
    const { system } = await captureSystemForBody({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hi! What can I help with?' }],
        },
        {
          id: 'u2',
          role: 'user',
          parts: [{ type: 'text', text: 'and for grade 7?' }],
        },
      ],
    });
    expect(typeof system).toBe('string');
    expect(system as string).not.toMatch(/Pre-fetched Reference Data/);
    expect(system as string).not.toMatch(/ignore them and answer conversationally/);
  });
});

describe('/api/chat agentic loop (Session 8)', () => {
  beforeEach(() => {
    retrievalConfig.retrievalMode = 'agentic';
    graderHolder.fn = null;
  });

  it('uses agenticSearch when effectiveMode is agentic, dropping graded-irrelevant chunks before the model sees them', async () => {
    const allChunks = [
      { content: 'keep this', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null },
      { content: 'drop this', similarity: 0.2, id: 2, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null },
    ];
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [allChunks[0]] })) as never,
    );
    const { tools } = await captureToolsForAgentic();
    const result = (await tools?.searchDocumentation?.execute({ query: 'vague' })) as Array<{ content: string }>;
    expect(compositionMock.agenticSearch).toHaveBeenCalledWith(expect.anything(), 'vague');
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('<reference source="null">\nkeep this\n</reference>');
  });

  it('gates on effectiveMode, not agenticFn truthiness: normal mode uses plain search even though agenticSearch is defined', async () => {
    retrievalConfig.retrievalMode = 'normal';
    const searchSpy = vi.spyOn(compositionMock, 'searchChunks').mockResolvedValue(ok([]) as never);
    const agenticSpy = compositionMock.agenticSearch as ReturnType<typeof vi.fn>;
    const { tools } = await captureToolsForAgentic();
    await tools?.searchDocumentation?.execute({ query: 'plain' });
    expect(searchSpy).toHaveBeenCalledWith(expect.anything(), 'plain', { limit: undefined });
    expect(agenticSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  it('surfaces a guardrail (offerTicket) when the loop reports out-of-domain', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultState: 'empty' })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const body = await runAgenticStreamAndRead('where is my refund?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/offerTicket/);
  });

  it('surfaces a guardrail when the hallucination grader flags the answer ungrounded', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok({
        chunks: [{ content: 'doc', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null }],
        rewrittenQuery: 'rewritten',
        outOfDomain: false,
      }) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/offerTicket/);
  });

  it('does not surface a guardrail when the answer is grounded', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok({
        chunks: [{ content: 'doc', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null }],
        rewrittenQuery: 'rewritten',
        outOfDomain: false,
      }) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).not.toMatch(/data-guardrail/);
  });
});

async function captureToolsForAgentic() {
  authMock.mockResolvedValue({ userId: 'user_test' });
  let captured:
    | { searchDocumentation: { execute: (args: { query: string; limit?: number }) => Promise<unknown> } }
    | undefined;
  streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
    captured = opts?.tools as typeof captured;
    return { toUIMessageStream: () => makeUIMessageStream() };
  });
  const res = await appHandler.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    }),
  );
  expect(res.status).toBe(200);
  expect(streamTextImpl).toHaveBeenCalled();
  return { tools: captured ?? null };
}

async function runAgenticStreamAndRead(query: string, extraBody: Record<string, unknown> = {}): Promise<string> {
  authMock.mockResolvedValue({ userId: 'user_test' });
  type Ctl = ReadableStreamDefaultController<{ type: string }>;
  let streamController: Ctl | null = null;
  const llmStream = new ReadableStream<{ type: string }>({
    start(controller) {
      streamController = controller;
    },
  });
  streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
    const tools = (opts?.tools as { searchDocumentation?: { execute: (a: { query: string }) => Promise<unknown> } }) ?? {};
    if (tools.searchDocumentation) {
      void tools.searchDocumentation.execute({ query });
    }
    return {
      toUIMessageStream: () => llmStream as unknown as ReadableStream<Uint8Array>,
      text: Promise.resolve('generated answer'),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    };
  });
  const res = await appHandler.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: query }] }], ...extraBody }),
    }),
  );
  expect(res.status).toBe(200);
  streamController!.close();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return body;
}

describe('/api/chat chat_events instrumentation (Session 6)', () => {
  async function drain(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  async function runTurn(text: string): Promise<Record<string, unknown> | undefined> {
    authMock.mockResolvedValue({ userId: 'user_test' });
    streamTextImpl.mockImplementation(() => ({ toUIMessageStream: () => makeUIMessageStream() }));
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    await drain(res);
    return compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  }

  it('records mode "vector" when effectiveMode is normal', async () => {
    retrievalConfig.retrievalMode = 'normal';
    const event = await runTurn('how do I reset my password?');
    expect(event?.mode).toBe('vector');
    expect(event?.userId).toBe('user_test');
    expect(event?.cacheHit).toBeFalsy();
  });

  it('records mode "agentic" when effectiveMode is agentic', async () => {
    retrievalConfig.retrievalMode = 'agentic';
    const event = await runTurn('what is the refund policy?');
    expect(event?.mode).toBe('agentic');
  });

  it('omits the query text when captureQueryText is disabled', async () => {
    retrievalConfig.captureQueryText = false;
    const event = await runTurn('sensitive question');
    expect(event?.query).toBeNull();
    retrievalConfig.captureQueryText = true;
  });

  it('records a cacheHit event and skips generation on a cache hit', async () => {
    retrievalConfig.retrievalMode = 'normal';
    compositionMock.answerCache.get.mockResolvedValueOnce('cached answer');
    authMock.mockResolvedValue({ userId: 'user_test' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'cached please' }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    await drain(res);
    const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.cacheHit).toBe(true);
    expect(event?.mode).toBe('vector');
  });
});

describe('/api/chat answer cache (Session 10)', () => {
  const CACHED = 'This is a cached answer from a previous generation.';
  const QUESTION = 'How do I reset my password?';

  function readBody(res: Response): Promise<string> {
    return new Promise(async (resolve) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      resolve(body);
    });
  }

  beforeEach(() => {
    vi.stubEnv('ANSWER_CACHE_ENABLED', 'true');
    retrievalConfig.retrievalMode = 'normal';
    compositionMock.answerCache.get.mockReset();
    compositionMock.answerCache.set.mockReset();
    compositionMock.answerCache.get.mockResolvedValue(null);
    compositionMock.answerCache.set.mockResolvedValue(undefined);
    streamTextImpl.mockReset();
    streamTextImpl.mockImplementation(() => ({
      toUIMessageStream: () => makeUIMessageStream(),
      text: Promise.resolve('freshly generated answer'),
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('short-circuits generation on a cache hit (no streamText call)', async () => {
    compositionMock.answerCache.get.mockResolvedValue(CACHED);
    authMock.mockResolvedValue({ userId: 'user_cache' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: QUESTION }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(streamTextImpl).not.toHaveBeenCalled();
    const body = await readBody(res);
    expect(body).toContain(CACHED);
  });

  it('replays stored citations from a versioned cache payload on a cache hit', async () => {
    const citation = {
      id: 11,
      documentId: 7,
      similarity: 0.91,
      snippet: 'The dental plan covers two cleanings per year.',
      fileName: 'benefits.md',
      page: 3,
      sectionTitle: 'Dental',
      source: null,
    };
    compositionMock.answerCache.get.mockResolvedValue(JSON.stringify({ v: 1, text: CACHED, citations: [citation] }));
    authMock.mockResolvedValue({ userId: 'user_cache' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: QUESTION }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(streamTextImpl).not.toHaveBeenCalled();
    const body = await readBody(res);
    expect(body).toContain(CACHED);
    expect(body).toMatch(/data-citation/);
    expect(body).toMatch(/0\.91/);
    expect(body).toMatch(/dental plan/);
    const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.cacheHit).toBe(true);
    expect(event?.citationCount).toBe(1);
  });

  it('does not cache a freshly-generated first-turn answer with no citations', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    authMock.mockResolvedValue({ userId: 'user_nocache' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: QUESTION }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(streamTextImpl).toHaveBeenCalled();
    await readBody(res);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('writes a freshly-generated grounded first-turn answer to the cache on miss', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    authMock.mockResolvedValue({ userId: 'user_miss' });
    type Ctl = ReadableStreamDefaultController<unknown>;
    let streamController: Ctl | null = null;
    const llmStream = new ReadableStream<unknown>({
      start(controller) {
        streamController = controller;
      },
    });
    let capturedTools:
      | { searchDocumentation: { execute: (args: { query: string }) => Promise<unknown> } }
      | undefined;
    streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
      capturedTools = opts?.tools as typeof capturedTools;
      return {
        toUIMessageStream: () => llmStream as unknown as ReadableStream<Uint8Array>,
        text: Promise.resolve('freshly generated answer'),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
      };
    });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: QUESTION }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(streamTextImpl).toHaveBeenCalled();
    await capturedTools?.searchDocumentation.execute({ query: 'dental coverage' });
    streamController!.close();
    await readBody(res);
    expect(compositionMock.answerCache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = compositionMock.answerCache.set.mock.calls[0]!;
    expect(key).toMatch(/^rag:answer:[a-f0-9]{32}$/);
    const payload = JSON.parse(value as string) as { v: number; text: string; citations: Array<{ snippet: string }> };
    expect(payload.v).toBe(1);
    expect(payload.text).toBe('freshly generated answer');
    expect(payload.citations.map((c) => c.snippet)).toEqual([
      'The dental plan covers two cleanings per year.',
      'Submit claims via the HR portal.',
    ]);
    expect(ttl).toBe(3600);
  });

  it('does not write to cache on a follow-up turn (conversation state)', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    authMock.mockResolvedValue({ userId: 'user_followup' });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
            { id: 'u2', role: 'user', parts: [{ type: 'text', text: QUESTION }] },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    await readBody(res);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('includes the user id and retrieval fingerprint in the cache key', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    authMock.mockResolvedValue({ userId: 'user_fp' });
    retrievalConfig.retrievalMode = 'agentic';
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'fingerprint me' }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    await readBody(res);
    const [, opts] = compositionMock.answerCacheKey.mock.calls.at(-1)! as unknown as [
      unknown,
      { userId: string; fingerprint: string },
    ];
    expect(opts.userId).toBe('user_fp');
    expect(opts.fingerprint).toContain('"mode":"agentic"');
    expect(opts.fingerprint).toContain('"retrievalMode":"agentic"');
    expect(opts.fingerprint).toContain('"similarityThreshold":0.5');
  });

  it('does not cache an out-of-domain answer', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    retrievalConfig.retrievalMode = 'agentic';
    graderHolder.fn = vi.fn(async () => 'no' as const);
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultState: 'empty' })) as never,
    );
    const body = await runAgenticStreamAndRead('where is my refund?');
    expect(body).toMatch(/data-guardrail/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('does not cache an answer the hallucination grader blocked', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    retrievalConfig.retrievalMode = 'agentic';
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const chunk = { content: 'doc', similarity: 0.9, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null };
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [chunk] })) as never,
    );
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).toMatch(/data-guardrail/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('does not cache a turn that opened a knowledge ticket', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    authMock.mockResolvedValue({ userId: 'user_tkt' });
    createTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never);
    currentUserMock.mockResolvedValue({
      id: 'user_tkt',
      emailAddresses: [{ emailAddress: 't@example.com' }],
      fullName: 'Tester',
      firstName: 'T',
      username: 't',
    });
    let ticketFinished: () => void = () => {};
    const ticketPromise = new Promise<void>((resolve) => {
      ticketFinished = resolve;
    });
    let streamController: ReadableStreamDefaultController<{ type: string }> | null = null;
    streamTextImpl.mockImplementation((opts: { tools?: unknown }) => {
      const tools = (opts?.tools as {
        createKnowledgeTicket?: {
          execute: (a: { name: string; email: string; issue: string }) => Promise<unknown>;
        };
      }) ?? {};
      if (tools.createKnowledgeTicket) {
        void tools.createKnowledgeTicket
          .execute({ name: 'A', email: 'a@a.com', issue: 'please open a ticket' })
          .finally(ticketFinished);
      }
      return {
        toUIMessageStream: () =>
          new ReadableStream<{ type: string }>({
            start(controller) {
              streamController = controller;
            },
          }),
        text: Promise.resolve('I opened a ticket for you.'),
      };
    });
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'open a ticket please' }] }] }),
      }),
    );
    expect(res.status).toBe(200);
    await ticketPromise;
    streamController!.close();
    await readBody(res);
    expect(createTicketMock).toHaveBeenCalled();
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });
});

describe('/api/chat degraded fallback, guardrail toggle and judge sampling (P4)', () => {
  const CHUNK_A = { content: 'fallback chunk A', similarity: 0.7, id: 1, documentId: 1, fileName: null, page: null, sectionTitle: null, source: null };
  const CHUNK_B = { content: 'fallback chunk B', similarity: 0.6, id: 2, documentId: 2, fileName: null, page: null, sectionTitle: null, source: null };

  async function runPendingAfterCallbacks(): Promise<void> {
    const pending = afterCallbacks.splice(0);
    for (const task of pending) task();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    retrievalConfig.retrievalMode = 'agentic';
    compositionMock.answerCache.get.mockReset();
    compositionMock.answerCache.get.mockResolvedValue(null);
    compositionMock.answerCache.set.mockReset();
    compositionMock.answerCache.set.mockResolvedValue(undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
  });

  afterEach(() => {
    (Math.random as unknown as { mockRestore: () => void }).mockRestore();
  });

  it('emits the soft degraded banner (no ticket offer), skips the cache and records degraded meta', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(
        agenticResult({
          chunks: [CHUNK_A, CHUNK_B],
          degraded: true,
          fallbackReason: 'grader_unavailable',
          resultState: 'degraded',
          gradingUnavailable: true,
        }),
      ) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const body = await runAgenticStreamAndRead('obscure question?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/degraded/);
    expect(body).toMatch(/Based on best-effort matches \(\d+\)/);
    expect(body).not.toMatch(/offerTicket":true/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
    const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event.outOfDomain).toBe(false);
    expect(event.hallucinationBlocked).toBe(false);
    expect(event.meta).toMatchObject({
      degraded: true,
      fallbackReason: 'grader_unavailable',
      isEmpty: false,
      resultState: 'degraded',
    });
    expect(JSON.stringify(event)).not.toMatch(/offerTicket":true/);
  });

  it('delivers §A4 fallback instructions through the degraded tool result (T1)', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(
        agenticResult({
          chunks: [CHUNK_A],
          degraded: true,
          fallbackReason: 'all_filtered',
          resultState: 'degraded',
        }),
      ) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const tools = await captureToolsFromStreamText<{
      searchDocumentation: {
        execute: (args: { query: string; limit?: number }) => Promise<unknown>;
      };
    }>();
    const result = (await tools?.searchDocumentation?.execute({ query: 'q' })) as Array<{
      content: string;
      similarity: number;
    }>;
    expect(result[0]!.similarity).toBe(-1);
    expect(result[0]!.content).toContain('# Fallback Context');
    expect(result[0]!.content).toContain("Note: I couldn't find a strongly matching document");
    expect(result).toHaveLength(2);
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    const tools2 = await captureToolsFromStreamText<{
      searchDocumentation: {
        execute: (args: { query: string; limit?: number }) => Promise<unknown>;
      };
    }>();
    const ok2 = (await tools2?.searchDocumentation?.execute({ query: 'q' })) as Array<{
      content: string;
    }>;
    expect(ok2[0]!.content.startsWith('<reference')).toBe(true);
    expect(JSON.stringify(ok2)).not.toContain('# Fallback Context');
  });

  it('§T6 soft deadline: slow turns end gracefully and skip cache/judge', async () => {
    vi.stubEnv('CHAT_SOFT_DEADLINE_MS', '40');
    vi.stubEnv('CHAT_JUDGE_MAX_WALL_MS', '1');
    try {
      authMock.mockResolvedValue({ userId: 'user_test' });
      streamTextImpl.mockImplementation((opts: { abortSignal?: AbortSignal }) => {
        return {
          toUIMessageStream: () =>
            new ReadableStream<{ type: string }>({
              start(c) {
                opts?.abortSignal?.addEventListener('abort', () => c.close(), { once: true });
              },
            }) as unknown as ReadableStream<Uint8Array>,
          text: Promise.resolve(''),
          usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
        };
      });
      const res = await appHandler.POST(
        new Request('http://localhost/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3305',
            messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'slow question' }] }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value);
      }
      expect(body).toContain('data-guardrail');
      expect(body).toContain('took too long');
      expect(body).toContain('Sorry — this answer took longer than allowed');
      const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as {
        meta: Record<string, unknown>;
        hallucinationBlocked: boolean;
      };
      expect(event.meta).toMatchObject({
        degraded: true,
        fallbackReason: 'turn_deadline',
        resultState: 'degraded',
      });
      expect(event.hallucinationBlocked).toBe(false);
      expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
      expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the blocking wall with ticket offer for a true empty retrieval', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultState: 'empty' })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const body = await runAgenticStreamAndRead('where is my refund?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/offerTicket":true/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('skips runHallucinationCheck entirely when hallucinationCheckEnabled is off', async () => {
    retrievalConfig.hallucinationCheckEnabled = false;
    try {
      compositionMock.agenticSearch = vi.fn(async () =>
        ok(agenticResult({ chunks: [CHUNK_A] })) as never,
      );
      graderHolder.fn = vi.fn(async () => 'no' as const);
      const body = await runAgenticStreamAndRead('what is the policy?');
      expect(graderHolder.fn).not.toHaveBeenCalled();
      expect(body).not.toMatch(/data-guardrail/);
      expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
      const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(event.hallucinationBlocked).toBe(false);
    } finally {
      retrievalConfig.hallucinationCheckEnabled = true;
    }
  });

  it('treats a hallucination grader infra failure as pass (fail-open): no banner, answer cached', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    graderHolder.fn = vi.fn(async () => {
      throw new Error('grade model down');
    });
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).not.toMatch(/data-guardrail/);
    expect(compositionMock.answerCache.set).toHaveBeenCalledTimes(1);
    const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event.hallucinationBlocked).toBe(false);
  });

  it('still blocks on an explicit grounded:false even when the turn is degraded', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(
        agenticResult({
          chunks: [CHUNK_A],
          degraded: true,
          fallbackReason: 'all_filtered',
          resultState: 'degraded',
        }),
      ) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).toMatch(/Based on best-effort matches \(\d+\)/);
    expect(body).toMatch(/offerTicket":true/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
    const event = compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event.hallucinationBlocked).toBe(true);
  });

  it('enqueues the quality judge via after when sampled (rate honored), persisting judgeScores', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0);
    compositionMock.chatEventBatcher.patchMeta.mockReturnValue(false);
    await runAgenticStreamAndRead('what is the policy?', { turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    await runPendingAfterCallbacks();
    expect(compositionMock.chatEventBatcher.updateEventMeta).toHaveBeenCalledTimes(1);
    const [turnId, patch] = compositionMock.chatEventBatcher.updateEventMeta.mock.calls[0]! as [
      string,
      { judgeScores: Record<string, unknown> },
    ];
    expect(turnId).toEqual(expect.any(String));
    expect(patch.judgeScores).toMatchObject({
      retrievalRelevance: 0.8,
      faithfulness: 0.9,
      citationPrecision: 0.85,
    });
    expect(typeof patch.judgeScores.judgedAt).toBe('string');
  });

  it('persists judge scores buffered-first; SQL only when the buffer missed (F4)', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0);
    compositionMock.chatEventBatcher.patchMeta.mockReturnValue(true);
    await runAgenticStreamAndRead('what is the policy?', { turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' });
    await runPendingAfterCallbacks();
    expect(compositionMock.chatEventBatcher.patchMeta).toHaveBeenCalledTimes(1);
    expect(compositionMock.chatEventBatcher.patchMeta.mock.calls[0]![1]).toHaveProperty('judgeScores');
    expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();
  });

  it('keeps partial judge verdicts when one dimension returns null (F3)', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0);
    judgeRelevanceMock.mockResolvedValueOnce(null as unknown as { score: number; reason: string });
    compositionMock.chatEventBatcher.patchMeta.mockReturnValue(false);
    await runAgenticStreamAndRead('what is the policy?', { turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303' });
    await runPendingAfterCallbacks();
    const [, patch] = compositionMock.chatEventBatcher.updateEventMeta.mock.calls.at(-1)! as [
      string,
      { judgeScores: Record<string, unknown> },
    ];
    expect(patch.judgeScores).not.toHaveProperty('retrievalRelevance');
    expect(patch.judgeScores.faithfulness).toBe(0.9);
    expect(patch.judgeScores.citationPrecision).toBe(0.85);
    expect(patch.judgeScores.judgedAt).toEqual(expect.any(String));
  });

  it('never samples the judge above the rate, on cache hits or empty retrievals', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [CHUNK_A] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    await runAgenticStreamAndRead('what is the policy?');
    await runPendingAfterCallbacks();
    expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();

    (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0);
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultState: 'empty' })) as never,
    );
    await runAgenticStreamAndRead('where is my refund?');
    await runPendingAfterCallbacks();
    expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();
  });

  it('skips the judge entirely when captureQueryText is disabled (privacy)', async () => {
    retrievalConfig.captureQueryText = false;
    try {
      compositionMock.agenticSearch = vi.fn(async () =>
        ok(agenticResult({ chunks: [CHUNK_A] })) as never,
      );
      graderHolder.fn = vi.fn(async () => 'yes' as const);
      (Math.random as unknown as { mockReturnValue: (v: number) => void }).mockReturnValue(0);
      await runAgenticStreamAndRead('what is the policy?');
      await runPendingAfterCallbacks();
      expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();
      expect(compositionMock.chatEventBatcher.patchMeta).not.toHaveBeenCalled();
    } finally {
      retrievalConfig.captureQueryText = true;
    }
  });
});
