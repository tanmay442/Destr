import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from '@app/domain';
import type { Composition } from '@/composition';
import {
  createScriptedBackend,
  type ScriptedStep,
} from '../../../../packages/application/src/agent/scripted-model';
import type { AgentModelBackend } from '../../../../packages/application/src/agent/model-backend';

const { searchValue, ticketInsertedValues, createTicketMock } = vi.hoisted(() => ({
  searchValue: [
    {
      id: 1,
      documentId: 1,
      fileName: 'benefits.md',
      page: 1,
      sectionTitle: 'Dental',
      source: null,
      title: 'Benefits',
      content: 'The dental plan covers two cleanings per year.',
      chunkIndex: 0,
      scores: { dense: 0.91, finalRank: 1, finalSignal: 'dense' as const },
    },
    {
      id: 2,
      documentId: 1,
      fileName: 'claims.md',
      page: 2,
      sectionTitle: 'Claims',
      source: null,
      title: 'Claims',
      content: 'Submit claims via the HR portal.',
      chunkIndex: 1,
      scores: { dense: 0.62, finalRank: 2, finalSignal: 'dense' as const },
    },
  ],
  ticketInsertedValues: [] as Array<Record<string, unknown>>,
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
    rerankerThreshold: 0.5,
    hybridEnabled: true,
    lexicalSearchMode: 'weighted_websearch' as const,
    agenticQueryRewriteEnabled: true,
    hallucinationCheckEnabled: true,
    judgeSampleRate: 0.02,
    rerankerProvider: 'cosine' as const,
    auxModel: undefined as string | undefined,
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
  modelGateway: {
    createStream: (input: { execute: (writer: { write: (chunk: unknown) => void }) => void }) => ReadableStream<unknown>;
    defineTool: (opts: { description: string; inputSchema: unknown }) => unknown;
    createModelBackend: ReturnType<typeof vi.fn>;
  };
  answerCacheKey: ReturnType<typeof vi.fn>;
  answerCache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    lease: {
      tryAcquire: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
  };
  turnResultCache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  appendChatTurn: ReturnType<typeof vi.fn>;
  cacheLeasePolicy: string;
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

const { scriptState, createModelBackendMock } = vi.hoisted(() => ({
  scriptState: {
    defaultSteps: [{ text: '' }] as unknown[],
    queue: [] as unknown[][],
    backends: [] as unknown[],
  },
  createModelBackendMock: vi.fn(),
}));

const { compositionMock } = vi.hoisted<{ compositionMock: MockComposition }>(() => {
  const createStreamImpl = (input: {
    execute: (writer: { write: (chunk: unknown) => void }) => void;
  }): ReadableStream<unknown> => {
    const out: unknown[] = [];
    input.execute({
      write: (chunk: unknown): void => {
        out.push(chunk);
      },
    });
    return new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of out) controller.enqueue(chunk);
        controller.close();
      },
    });
  };
  return {
    compositionMock: {
    rateLimit: () => rateLimitResult,
    searchChunks: vi.fn(async () => ok({ chunks: searchValue, degradedBy: [] }) as never),
    createTicket: createTicketMock,
    getChatModel: vi.fn(() => ({ modelId: 'mock' })),
    getEmbeddingModel: vi.fn(() => ({ modelId: 'mock-embed' })),
    getEmbeddingModelId: vi.fn(() => 'mock-embed'),
    modelGateway: {
      createStream: createStreamImpl,
      defineTool: (opts: { description: string; inputSchema: unknown }) => opts,
      createModelBackend: createModelBackendMock,
    },
    answerCacheKey: vi.fn((query: string, opts?: { userId?: string; fingerprint?: string }) =>
      `rag:answer:${Buffer.from(query + (opts?.userId ?? '') + (opts?.fingerprint ?? '')).toString('hex').slice(0, 32)}`,
    ),
    answerCache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      lease: {
        tryAcquire: vi.fn(async () => `test-token-${Math.random()}`),
        release: vi.fn(async () => undefined),
      },
    },
    turnResultCache: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    },
    appendChatTurn: vi.fn(async () => ({ ok: true as const, value: null })),
    cacheLeasePolicy: 'degraded',
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
  };
});

vi.mock('@/composition', () => ({
  getComposition: () => compositionMock as unknown as Composition,
  appConfig: appConfigMock,
  assertSameOrigin: assertSameOriginMock,
  TRACE_ENABLED: false,
  judgeRelevance: judgeRelevanceMock,
  judgeFaithfulness: judgeFaithfulnessMock,
}));

import * as appHandler from './route';

type ScriptedBackend = ReturnType<typeof createScriptedBackend>;
type BackendStepInput = Parameters<AgentModelBackend['generateStep']>[0];
type BackendStepOutput = Awaited<ReturnType<AgentModelBackend['generateStep']>>;

interface BackendCallRecord {
  readonly activeTools: ReadonlyArray<string>;
  readonly system: string;
}

interface InspectableBackend extends AgentModelBackend {
  readonly calls: ReadonlyArray<BackendCallRecord>;
}

function resetModelBackend(): void {
  scriptState.backends.length = 0;
  scriptState.queue.length = 0;
  scriptState.defaultSteps = [{ text: '' }];
  createModelBackendMock.mockReset();
  createModelBackendMock.mockImplementation(() => {
    const queued = scriptState.queue.shift() as ScriptedStep[] | undefined;
    const steps = queued ?? (scriptState.defaultSteps as ScriptedStep[]);
    const backend = createScriptedBackend(steps);
    scriptState.backends.push(backend);
    return backend;
  });
}

function setDefaultScript(steps: readonly ScriptedStep[]): void {
  scriptState.defaultSteps = [...steps];
  scriptState.queue.length = 0;
}

function latestBackend(): ScriptedBackend | undefined {
  const backends = scriptState.backends as ScriptedBackend[];
  return backends[backends.length - 1];
}

function modelVisibleText(backend: ScriptedBackend | undefined): string {
  return (backend?.calls ?? [])
    .flatMap((call) => call.messages.map((message) => message.text))
    .join('\n');
}

function createGatedBackend(gate: Promise<void>): InspectableBackend {
  const calls: BackendCallRecord[] = [];
  return {
    get calls(): ReadonlyArray<BackendCallRecord> {
      return calls;
    },
    async generateStep(input: BackendStepInput): Promise<BackendStepOutput> {
      calls.push({ activeTools: [...Object.keys(input.activeTools)], system: input.system });
      await gate;
      return {
        text: 'gated answer',
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheStatus: 'unsupported',
        finishReason: 'stop',
      };
    },
  };
}

function createAbortHangingBackend(): InspectableBackend {
  const calls: BackendCallRecord[] = [];
  return {
    get calls(): ReadonlyArray<BackendCallRecord> {
      return calls;
    },
    async generateStep(input: BackendStepInput): Promise<BackendStepOutput> {
      calls.push({ activeTools: [...Object.keys(input.activeTools)], system: input.system });
      await new Promise<void>((_resolve, reject) => {
        if (input.signal.aborted) {
          reject(new DOMException('Chat turn was cancelled.', 'AbortError'));
          return;
        }
        input.signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Chat turn was cancelled.', 'AbortError'));
          },
          { once: true },
        );
      });
      throw new Error('unreachable: abort always settles the gate');
    },
  };
}

function agenticResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunks: [],
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

function testChunk(content: string, dense: number, id = 1) {
  return {
    id,
    documentId: 1,
    fileName: null,
    page: null,
    sectionTitle: null,
    source: null,
    title: null,
    content,
    chunkIndex: id - 1,
    scores: { dense, finalRank: id, finalSignal: 'dense' as const },
  };
}

function chatBody(text: string): {
  messages: Array<{ id: string; role: string; parts: Array<{ type: string; text: string }> }>;
} {
  return { messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }] };
}

async function postChat(body: unknown, userId: string | null = 'user_test'): Promise<Response> {
  authMock.mockResolvedValue({ userId });
  return appHandler.POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function readBodyText(res: Response): Promise<string> {
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

async function drainResponse(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function lastRecordedEvent(): Record<string, unknown> | undefined {
  return compositionMock.chatEventBatcher.record.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

function searchThenText(query: string, finalText: string, limit?: number): ScriptedStep[] {
  return [
    { toolCalls: [{ toolName: 'searchDocumentation', args: limit === undefined ? { query } : { query, limit } }] },
    { text: finalText },
  ];
}

beforeEach(() => {
  resetModelBackend();
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
    const res = await postChat(chatBody('hi'), null);
    expect(res.status).toBe(401);
    expect(createModelBackendMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the rate limiter says so', async () => {
    rateLimitResult.ok = false;
    (rateLimitResult as unknown as { retryAfterMs: number }).retryAfterMs = 5_000;
    const res = await postChat(chatBody('hi'), 'user_1');
    expect(res.status).toBe(429);
    expect(createModelBackendMock).not.toHaveBeenCalled();
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
        body: JSON.stringify(chatBody('hi')),
      }),
    );
    expect(res.status).toBe(403);
    expect(createModelBackendMock).not.toHaveBeenCalled();
  });

  it('returns 413 for a body larger than the cap via streaming read', async () => {
    const res = await postChat(chatBody('x'.repeat(2_000_000)), 'user_big');
    expect(res.status).toBe(413);
    expect(createModelBackendMock).not.toHaveBeenCalled();
  });

  it('returns 499 when the client cancels the request body', async () => {
    authMock.mockResolvedValue({ userId: 'user_cancelled' });
    const controller = new AbortController();
    controller.abort();
    const res = await appHandler.POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(499);
    expect(createModelBackendMock).not.toHaveBeenCalled();
  });

  it('caps concurrent streams per user at 2, freeing the slot when a stream ends', async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    createModelBackendMock.mockReset();
    createModelBackendMock.mockImplementation(() => createGatedBackend(gate));
    const payload = chatBody('hi');
    const makePost = () => postChat(payload, 'user_conc');
    const r1 = await makePost();
    const r2 = await makePost();
    const r3 = await makePost();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBe('1');
    expect(createModelBackendMock).toHaveBeenCalledTimes(2);
    releaseGate();
    await drainResponse(r1);
    await drainResponse(r2);
    const r4 = await makePost();
    expect(r4.status).toBe(200);
    await drainResponse(r4);
  });

  it('passes a createKnowledgeTicket tool to the model backend', async () => {
    setDefaultScript([{ text: 'done' }]);
    const res = await postChat(chatBody('How do I reset my password? Please open a ticket.'));
    expect(res.status).toBe(200);
    await readBodyText(res);
    const backend = latestBackend();
    expect(backend).toBeDefined();
    expect(backend?.calls[0]?.activeTools).toContain('createKnowledgeTicket');
  });
});

describe('/api/chat createKnowledgeTicket tool', () => {
  interface TicketArgs {
    question: string;
    attempted: string[];
    documentationSearched: string[];
    context?: string;
  }

  async function runTicketTurn(
    overrides: TicketArgs,
    messageText = 'How do I reset my password? Please open a ticket.',
  ) {
    const args: Record<string, unknown> = {
      question: overrides.question,
      attempted: [...overrides.attempted],
      documentationSearched: [...overrides.documentationSearched],
    };
    if (overrides.context !== undefined) args.context = overrides.context;
    setDefaultScript([
      { toolCalls: [{ toolName: 'createKnowledgeTicket', args }] },
      { text: 'I opened a ticket for you.' },
    ]);
    const res = await postChat(chatBody(messageText));
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    return { res, body, backend: latestBackend() };
  }

  function ticketInput(overrides: Partial<{ question: string; attempted: string[]; documentationSearched: string[] }> = {}) {
    return {
      question: 'Cannot reset my password.',
      attempted: ['searched password reset'],
      documentationSearched: ['password reset'],
      ...overrides,
    };
  }

  it('creates a ticket with a TKT- prefixed id from the authenticated profile, never model-supplied identity', async () => {
    createTicketMock.mockResolvedValueOnce(ok({ ticketId: 'TKT-abcd1234', status: 'created' }) as never);
    const { body, backend } = await runTicketTurn(ticketInput({ question: 'Cannot reset my password.' }));
    expect(body).toContain('I opened a ticket for you.');
    expect(backend?.calls.length).toBe(2);
    expect(createTicketMock).toHaveBeenCalledWith(
      {
        userId: 'user_test',
        name: 'Real Person',
        email: 'real@example.com',
        issue: expect.stringContaining('Question: Cannot reset my password.'),
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(lastRecordedEvent()?.ticketCreated).toBe(true);
  });

  it('rejects ticket creation when the Clerk user has no verified email', async () => {
    currentUserMock.mockResolvedValueOnce({
      id: 'user_nomail',
      emailAddresses: [],
      fullName: 'No Mail',
      firstName: 'No',
      username: 'nomail',
    });
    createTicketMock.mockResolvedValueOnce(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never);
    const { backend } = await runTicketTurn(ticketInput({ question: 'no email on account' }));
    expect(backend?.calls.length).toBe(2);
    expect(lastRecordedEvent()?.ticketCreated).toBe(false);
    expect(createTicketMock).not.toHaveBeenCalled();
  });

  it('generates unique ticket ids (UUID-based, no collision retry needed)', async () => {
    createTicketMock
      .mockResolvedValueOnce(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never)
      .mockResolvedValueOnce(ok({ ticketId: 'TKT-bbbbbbbb', status: 'created' }) as never);
    setDefaultScript([
      { toolCalls: [{ toolName: 'createKnowledgeTicket', args: ticketInput({ question: 'first ticket' }) }] },
      { text: 'I opened a ticket for you.' },
    ]);
    const first = await postChat(chatBody('Please open a ticket for the first issue.'));
    expect(first.status).toBe(200);
    await readBodyText(first);
    setDefaultScript([
      { toolCalls: [{ toolName: 'createKnowledgeTicket', args: ticketInput({ question: 'second ticket' }) }] },
      { text: 'I opened a ticket for you.' },
    ]);
    const second = await postChat(chatBody('Please open a ticket for the second issue.'));
    expect(second.status).toBe(200);
    await readBodyText(second);
    expect(createTicketMock).toHaveBeenCalledTimes(2);
    const issues = createTicketMock.mock.calls.map((call) => (call[0] as { issue: string }).issue);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('first ticket');
    expect(issues[1]).toContain('second ticket');
    expect(issues[0]).not.toBe(issues[1]);
  });

  it('returns an error status when createTicket fails', async () => {
    const { ExternalServiceError } = await import('@app/domain');
    createTicketMock.mockResolvedValueOnce(err(new ExternalServiceError('db down')) as never);
    const { body } = await runTicketTurn(ticketInput({ question: 'my issue' }));
    expect(body).toContain('I opened a ticket for you.');
    expect(createTicketMock).toHaveBeenCalledTimes(1);
    expect(lastRecordedEvent()?.ticketCreated).toBe(false);
  });
});

describe('/api/chat searchDocumentation tool', () => {
  it('returns up to 800 chars per chunk wrapped in untrusted reference framing', async () => {
    const longContent = 'x'.repeat(2000);
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(
        ok({
          chunks: [{ ...testChunk(longContent, 0.8), source: 'https://docs.example.com/a.md' }],
          degradedBy: [],
        }) as never,
      );
    setDefaultScript(searchThenText('q', 'final answer'));
    const res = await postChat(chatBody('What does the documentation say about coverage?'));
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    const backend = latestBackend();
    expect(backend?.calls.length).toBe(2);
    const visible = modelVisibleText(backend);
    expect(visible).toContain('~~~ BEGIN UNTRUSTED EVIDENCE');
    expect(visible).toContain('~~~ END UNTRUSTED EVIDENCE ~~~');
    expect(visible).toContain('https://docs.example.com/a.md');
    expect(visible).toContain('x'.repeat(800) + '…');
    expect(visible).not.toContain('x'.repeat(801));
    expect(body).toMatch(/data-citation/);
    searchChunksSpy.mockRestore();
  });

  it('passes a user-supplied limit through to searchChunks', async () => {
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(ok({ chunks: [], degradedBy: [] }) as never);
    setDefaultScript(searchThenText('q', 'final answer', 5));
    const res = await postChat(chatBody('What does the documentation say about coverage?'));
    expect(res.status).toBe(200);
    await readBodyText(res);
    expect(searchChunksSpy).toHaveBeenCalledWith(expect.anything(), 'q', {
      excludeChunkIdentities: expect.any(Set),
      limit: 5,
      signal: expect.any(AbortSignal),
    });
    searchChunksSpy.mockRestore();
  });

  it('omits duplicate chunks from repeated retrieval results', async () => {
    const searchSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValue(ok({ chunks: searchValue, degradedBy: [] }) as never);
    setDefaultScript([
      {
        toolCalls: [
          { toolName: 'searchDocumentation', args: { query: 'q' } },
          { toolName: 'searchDocumentation', args: { query: 'q again' } },
        ],
      },
      { text: 'final answer' },
    ]);
    const res = await postChat(chatBody('What does the documentation say about coverage?'));
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(body).toContain('The dental plan covers two cleanings per year.');
    expect(body).toContain('Submit claims via the HR portal.');
    const visible = modelVisibleText(latestBackend());
    expect(visible).toContain('filtered_duplicates');
    expect(visible).toContain('"uniqueEvidenceAdded":2');
    expect(visible).toContain('"uniqueEvidenceAdded":0');
    searchSpy.mockRestore();
  });

  it('emits captured citations as data-citation parts after the LLM stream ends', async () => {
    setDefaultScript(searchThenText('q', 'final answer'));
    const res = await postChat(chatBody('hi there, what does the documentation say?'));
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    expect(body).toMatch(/data-citation/);
    expect(body).toMatch(/0\.91/);
    expect(body).toMatch(/dental plan/);
  });
});

describe('/api/chat pre-fetch toggle (default off)', () => {
  async function captureSystemForBody(body: { messages: unknown[] }) {
    setDefaultScript([{ text: '' }]);
    const res = await postChat(body);
    expect(res.status).toBe(200);
    await readBodyText(res);
    const backend = latestBackend();
    return { system: backend?.calls[0]?.system as string | undefined, res };
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

  it('rejects an empty last user message before model generation', async () => {
    const modelCallsBeforeRequest = createModelBackendMock.mock.calls.length;
    const res = await postChat({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '' }] }],
    });

    expect(res.status).toBe(400);
    expect(createModelBackendMock).toHaveBeenCalledTimes(modelCallsBeforeRequest);
  });

  it('with prefetchFirstTurn = false, citation still surfaces as data-citation when the tool is called', async () => {
    setDefaultScript(searchThenText('q', 'final answer'));
    const res = await postChat({
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'How do I change my password?' }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
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
      testChunk('keep this', 0.9, 1),
      testChunk('drop this', 0.2, 2),
    ];
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [allChunks[0]] })) as never,
    );
    setDefaultScript(searchThenText('vague', 'final answer'));
    const res = await postChat(chatBody('Can you explain the vague policy?'));
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    expect(compositionMock.agenticSearch).toHaveBeenCalledWith(expect.anything(), 'vague', {
      excludeChunkIdentities: expect.any(Set),
      limit: 3,
      signal: expect.any(AbortSignal),
    });
    expect(body).toContain('keep this');
    expect(body).not.toContain('drop this');
    const visible = modelVisibleText(latestBackend());
    expect(visible).toContain('~~~ BEGIN UNTRUSTED EVIDENCE');
    expect(visible).toContain('keep this');
    expect(visible).toContain('~~~ END UNTRUSTED EVIDENCE ~~~');
  });

  it('gates on effectiveMode, not agenticFn truthiness: normal mode uses plain search even though agenticSearch is defined', async () => {
    retrievalConfig.retrievalMode = 'normal';
    const searchSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValue(ok({ chunks: [], degradedBy: [] }) as never);
    const agenticSpy = compositionMock.agenticSearch as ReturnType<typeof vi.fn>;
    setDefaultScript(searchThenText('plain', 'final answer'));
    const res = await postChat(chatBody('Can you explain the plain policy?'));
    expect(res.status).toBe(200);
    await readBodyText(res);
    expect(searchSpy).toHaveBeenCalledWith(expect.anything(), 'plain', {
      excludeChunkIdentities: expect.any(Set),
      limit: 3,
      signal: expect.any(AbortSignal),
    });
    expect(agenticSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  it('surfaces a guardrail (offerTicket) when the loop reports out-of-domain', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultQuery: null, resultState: 'no_match' })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const body = await runAgenticStreamAndRead('where is my refund?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/offerTicket/);
  });

  it('surfaces a guardrail when the hallucination grader flags the answer ungrounded', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [testChunk('doc', 0.9)] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).toMatch(/data-guardrail/);
    expect(body).toMatch(/offerTicket/);
  });

  it('does not surface a guardrail when the answer is grounded', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [testChunk('doc', 0.9)] })) as never,
    );
    graderHolder.fn = vi.fn(async () => 'yes' as const);
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).not.toMatch(/data-guardrail/);
  });
});

async function runAgenticStreamAndRead(query: string, extraBody: Record<string, unknown> = {}): Promise<string> {
  setDefaultScript(searchThenText(query, 'generated answer'));
  const res = await postChat({
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: query }] }],
    ...extraBody,
  });
  expect(res.status).toBe(200);
  return readBodyText(res);
}

describe('/api/chat chat_events instrumentation (Session 6)', () => {
  async function runTurn(text: string): Promise<Record<string, unknown> | undefined> {
    setDefaultScript([{ text: '' }]);
    const res = await postChat(chatBody(text));
    expect(res.status).toBe(200);
    await readBodyText(res);
    return lastRecordedEvent();
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
    const res = await postChat(chatBody('cached please'));
    expect(res.status).toBe(200);
    await readBodyText(res);
    expect(createModelBackendMock).not.toHaveBeenCalled();
    const event = lastRecordedEvent();
    expect(event?.cacheHit).toBe(true);
    expect(event?.mode).toBe('vector');
  });
});

describe('/api/chat answer cache (Session 10)', () => {
  const CACHED = 'This is a cached answer from a previous generation.';
  const QUESTION = 'How do I reset my password?';

  beforeEach(() => {
    vi.stubEnv('ANSWER_CACHE_ENABLED', 'true');
    retrievalConfig.retrievalMode = 'normal';
    compositionMock.answerCache.get.mockReset();
    compositionMock.answerCache.set.mockReset();
    compositionMock.answerCache.get.mockResolvedValue(null);
    compositionMock.answerCache.set.mockResolvedValue(undefined);
    setDefaultScript([{ text: 'freshly generated answer' }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('short-circuits generation on a cache hit (no model backend call)', async () => {
    compositionMock.answerCache.get.mockResolvedValue(CACHED);
    const res = await postChat(chatBody(QUESTION), 'user_cache');
    expect(res.status).toBe(200);
    expect(createModelBackendMock).not.toHaveBeenCalled();
    const body = await readBodyText(res);
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
    const res = await postChat(chatBody(QUESTION), 'user_cache');
    expect(res.status).toBe(200);
    expect(createModelBackendMock).not.toHaveBeenCalled();
    const body = await readBodyText(res);
    expect(body).toContain(CACHED);
    expect(body).toMatch(/data-citation/);
    expect(body).toMatch(/0\.91/);
    expect(body).toMatch(/dental plan/);
    const event = lastRecordedEvent();
    expect(event?.cacheHit).toBe(true);
    expect(event?.citationCount).toBe(1);
  });

  it('does not cache a freshly-generated first-turn answer with no citations', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    const res = await postChat(chatBody(QUESTION), 'user_nocache');
    expect(res.status).toBe(200);
    expect(latestBackend()?.calls.length).toBeGreaterThan(0);
    await readBodyText(res);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('writes a freshly-generated grounded first-turn answer to the cache on miss', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    setDefaultScript(searchThenText('dental coverage', 'freshly generated answer'));
    const res = await postChat(chatBody(QUESTION), 'user_miss');
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    expect(body).toContain('freshly generated answer');
    expect(latestBackend()?.calls.length).toBeGreaterThan(0);
    expect(compositionMock.answerCache.set).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = compositionMock.answerCache.set.mock.calls[0]!;
    expect(key).toMatch(/^rag:answer:[a-f0-9]{32}$/);
    const payload = JSON.parse(value as string) as { v: number; text: string; citations: Array<{ snippet: string }> };
    expect(payload.v).toBe(2);
    expect(payload.text).toBe('freshly generated answer');
    expect(payload.citations.map((c) => c.snippet)).toEqual([
      'The dental plan covers two cleanings per year.',
      'Submit claims via the HR portal.',
    ]);
    expect(ttl).toBe(3600);
  });

  it('does not write to cache on a follow-up turn (conversation state)', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    const res = await postChat(
      {
        messages: [
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] },
          { id: 'u2', role: 'user', parts: [{ type: 'text', text: QUESTION }] },
        ],
      },
      'user_followup',
    );
    expect(res.status).toBe(200);
    await readBodyText(res);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('includes the user id and retrieval fingerprint in the cache key', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    retrievalConfig.retrievalMode = 'agentic';
    const res = await postChat(chatBody('fingerprint me'), 'user_fp');
    expect(res.status).toBe(200);
    await readBodyText(res);
    const [, opts] = compositionMock.answerCacheKey.mock.calls.at(-1)! as unknown as [
      unknown,
      { userId: string; fingerprint: string },
    ];
    expect(opts.userId).toBe('user_fp');
    expect(opts.fingerprint).toContain('"mode":"agentic"');
    expect(opts.fingerprint).toContain('"resultContractVersion":2');
    expect(opts.fingerprint).toContain('"retrievalMode":"agentic"');
    expect(opts.fingerprint).toContain('"similarityThreshold":0.5');
  });

  it('does not cache an out-of-domain answer', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    retrievalConfig.retrievalMode = 'agentic';
    graderHolder.fn = vi.fn(async () => 'no' as const);
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultQuery: null, resultState: 'no_match' })) as never,
    );
    const body = await runAgenticStreamAndRead('where is my refund?');
    expect(body).toMatch(/data-guardrail/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('does not cache an answer the hallucination grader blocked', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    retrievalConfig.retrievalMode = 'agentic';
    graderHolder.fn = vi.fn(async () => 'no' as const);
    const chunk = testChunk('doc', 0.9);
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ chunks: [chunk] })) as never,
    );
    const body = await runAgenticStreamAndRead('what is the policy?');
    expect(body).toMatch(/data-guardrail/);
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });

  it('does not cache a turn that opened a knowledge ticket', async () => {
    compositionMock.answerCache.get.mockResolvedValue(null);
    createTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-aaaaaaaa', status: 'created' }) as never);
    currentUserMock.mockResolvedValue({
      id: 'user_tkt',
      emailAddresses: [{ emailAddress: 't@example.com' }],
      fullName: 'Tester',
      firstName: 'T',
      username: 't',
    });
    setDefaultScript([
      {
        toolCalls: [
          {
            toolName: 'createKnowledgeTicket',
            args: {
              question: 'please open a ticket',
              attempted: ['searched docs'],
              documentationSearched: ['docs'],
            },
          },
        ],
      },
      { text: 'I opened a ticket for you.' },
    ]);
    const res = await postChat(chatBody('open a ticket please'), 'user_tkt');
    expect(res.status).toBe(200);
    const body = await readBodyText(res);
    expect(body).toContain('I opened a ticket for you.');
    expect(createTicketMock).toHaveBeenCalled();
    expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
  });
});

describe('/api/chat guardrail toggle and judge sampling (P4)', () => {
  const CHUNK_A = testChunk('fallback chunk A', 0.7);

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

  it('§T6 soft deadline: slow turns end gracefully and skip cache/judge', { timeout: 30_000 }, async () => {
    vi.stubEnv('CHAT_SOFT_DEADLINE_MS', '16000');
    vi.stubEnv('CHAT_JUDGE_MAX_WALL_MS', '1');
    try {
      createModelBackendMock.mockReset();
      createModelBackendMock.mockImplementation(() => createAbortHangingBackend());
      const res = await postChat({
        turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3305',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'slow question' }] }],
      });
      expect(res.status).toBe(200);
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
      const event = lastRecordedEvent() as {
        meta: Record<string, unknown>;
        hallucinationBlocked: boolean;
      };
      expect(event.meta).toMatchObject({
        fallbackReason: 'turn_deadline',
      });
      expect(event.meta).not.toHaveProperty('resultState');
      expect(event.meta).not.toHaveProperty('degraded');
      expect(event.hallucinationBlocked).toBe(false);
      expect(compositionMock.answerCache.set).not.toHaveBeenCalled();
      expect(compositionMock.chatEventBatcher.updateEventMeta).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps the blocking wall with ticket offer for a true empty retrieval', async () => {
    compositionMock.agenticSearch = vi.fn(async () =>
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultQuery: null, resultState: 'no_match' })) as never,
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
      const event = lastRecordedEvent();
      expect(event?.hallucinationBlocked).toBe(false);
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
    const event = lastRecordedEvent();
    expect(event?.hallucinationBlocked).toBe(false);
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
      ok(agenticResult({ outOfDomain: true, isEmpty: true, resultQuery: null, resultState: 'no_match' })) as never,
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
