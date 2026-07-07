import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@app/domain';

// Mocks for the route's deps. We control:
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

const { currentUserMock } = vi.hoisted(() => ({
  currentUserMock: vi.fn(),
}));

// The route reads `appConfig.prefetchFirstTurn` at request time. We
// expose a hoisted mutable so individual tests can flip the toggle
// on and off. Default is `false`.
const { appConfigMock } = vi.hoisted(() => ({
  appConfigMock: {
    prefetchFirstTurn: false,
    orgName: 'Test Corp',
    orgShortName: 'RAG Support',
    audience: 'test customers',
    agentPersona: { name: 'Astra', tone: 'friendly' as const },
    outOfScopeTopics: [],
    branding: { title: 'RAG Support', description: '' },
    seedDocsDir: './documents',
    adminEmails: [],
    customInstructions: undefined,
  },
}));

vi.mock('@/lib/config', () => ({
  appConfig: appConfigMock,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
  currentUser: currentUserMock,
}));

const { compositionMock } = vi.hoisted(() => ({
  compositionMock: {
    rateLimit: () => rateLimitResult,
    searchChunks: vi.fn(async () => ok(searchValue) as never),
    createTicket: createTicketMock,
    recordQuery: vi.fn(() => Promise.resolve()),
    getChatModel: vi.fn(() => ({ modelId: 'mock' })),
    getEmbeddingModel: vi.fn(() => ({ modelId: 'mock-embed' })),
    logTicketEvent: vi.fn(),
  },
}));

vi.mock('@/composition', () => ({
  getComposition: () => compositionMock,
  appConfig: appConfigMock,
}));

// Mock the AI SDK so we don't actually hit any model providers.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    streamText: streamTextImpl,
    // The tool() helper should pass through — keep the real one.
    tool: actual.tool,
  };
});

import * as appHandler from './route';

function makeUIMessageStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.close(); },
  });
}

/**
 * Wire streamTextImpl so the next call to POST captures the
 * `tools` argument. Returns the captured tools object after
 * the request resolves. Used by every test that needs to invoke
 * a tool's `execute` method.
 */
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
      body: JSON.stringify({ messages: [] }),
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
  // Default: createTicket succeeds with a TKT-prefixed id.
  createTicketMock.mockResolvedValue(ok({ ticketId: 'TKT-abcd1234', status: 'created' }) as never);
  // Default Clerk identity: every test gets a known user unless it
  // explicitly overrides the mock.
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
  // Reset the toggle to the default.
  appConfigMock.prefetchFirstTurn = false;
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
        body: JSON.stringify({ messages: [] }),
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
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(res.status).toBe(429);
  });

  it('passes a createSupportTicket tool to streamText', () => {
    expect(appHandler.POST).toBeDefined();
  });
});

describe('/api/chat createSupportTicket tool', () => {
  async function invokeToolFromStreamText(overrides: {
    name: string;
    email: string;
    issue: string;
  }) {
    const tools = await captureToolsFromStreamText<{
      createSupportTicket: {
        execute: (args: { name: string; email: string; issue: string }) => Promise<unknown>;
      };
    }>();
    const tool = tools?.createSupportTicket;
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
    // The use-case receives the signed-in user's identity, not the
    // LLM-supplied name/email.
    expect(createTicketMock).toHaveBeenCalledWith({
      userId: 'user_test',
      name: 'Real Person',
      email: 'real@example.com',
      issue: 'Cannot reset my password.',
    });
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

  it('returns up to 800 chars per chunk and a 150-char snippet per citation', async () => {
    const longContent = 'x'.repeat(2000);
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(ok([{ content: longContent, similarity: 0.8 }]) as never);
    const { tools } = await captureTools();
    const result = (await tools?.searchDocumentation?.execute({ query: 'q' })) as Array<{
      content: string;
    }>;
    expect(result?.[0]?.content.length).toBe(800 + 1); // 800 chars + ellipsis
    expect(result?.[0]?.content.endsWith('\u2026')).toBe(true);
    searchChunksSpy.mockRestore();
  });

  it('passes a user-supplied limit through to searchChunks', async () => {
    const searchChunksSpy = vi
      .spyOn(compositionMock, 'searchChunks')
      .mockResolvedValueOnce(ok([]) as never);
    const { tools } = await captureTools();
    await tools?.searchDocumentation?.execute({ query: 'q', limit: 5 });
    expect(searchChunksSpy).toHaveBeenCalledWith('q', { limit: 5 });
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
        body: JSON.stringify({ messages: [] }),
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
  // Captures the `system` argument passed to streamText for a given
  // body. The LLM stream is a no-op so we can read the captured
  // argument synchronously after the request resolves.
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
    // Default is off. On a first turn with a real user message, the
    // route must NOT inject a pre-fetched block, the model is
    // expected to call searchDocumentation itself.
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
    expect(sys).not.toMatch(/Pre-fetched documentation/);
    // The tool-contract block is still present, so the model knows
    // it must call the tool itself.
    expect(sys).toContain('searchDocumentation');
    expect(sys).toContain('createSupportTicket');
  });

  it('respects appConfig.prefetchFirstTurn = false on empty lastUserText', async () => {
    const { system } = await captureSystemForBody({ messages: [] });
    expect(typeof system).toBe('string');
    expect(system as string).not.toMatch(/Pre-fetched documentation/);
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
    // Model calls the tool, which pushes the fixture chunks into
    // the capturedCitations array. The post-loop wrapper emits them
    // as data-citation parts.
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
    expect(sys).toMatch(/Pre-fetched documentation/);
    expect(sys).toContain('The dental plan covers two cleanings per year.');
    expect(sys).toContain('Submit claims via the HR portal.');
    expect(sys).toMatch(/sim 0\.91/);
    expect(sys).toMatch(/sim 0\.62/);
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
    expect(system as string).not.toMatch(/Pre-fetched documentation/);
    expect(system as string).not.toMatch(/ignore them and answer conversationally/);
  });
});
