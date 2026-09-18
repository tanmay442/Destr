import { describe, it, expect, vi, afterEach } from 'vitest';
import { ok } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import { SearchFailure, type RetrievalDiagnostics, type RetrievedChunk } from '../../../rag/search';
import { chatTurn } from '../turn';
import type { ChatTurnDeps, ChatTurnResult } from '../turn-types';
import { SEARCH_TOOL_NAME } from '../../../agent/tools/search-documentation';
import {
  createScriptedBackend,
  type ScriptedStep,
} from '../../../agent/scripted-model';
import type { AgentModelBackend } from '../../../agent/model-backend';
import { createChatRequestSchema } from '../../request-schema';
import { AgentProgressEventSchema } from '../../progress/progress-event';
import type { ChatInputMessage } from '../../message-types';
import type { ChatChunk } from '../../chat-chunks';

/**
 * WP-8 F-29/F-42: production-path progress wiring.
 *
 * Drives chatTurn (not internal functions) with WP8_SERVER_PROGRESS_ENABLED=1
 * and asserts real phase emission, transient serialization, and the terminal
 * contract. With the flag off the stream is byte-identical to the pre-WP-8
 * shape (pinned below).
 */

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
    judgeSampleRate: 0,
    rerankerProvider: 'cosine',
    auxModel: undefined,
    answerCacheEnabled: true,
    answerCacheTtlSec: 3600,
    captureQueryText: true,
    prefetchFirstTurn: false,
    ...overrides,
  } as AppConfig;
}

function makeGateway(script: { queue: readonly ScriptedStep[] }) {
  return {
    createStream: ({ execute }: { execute: (writer: { write: (chunk: ChatChunk) => void }) => void }) =>
      new ReadableStream<ChatChunk>({
        start(controller) {
          const chunks: ChatChunk[] = [];
          execute({ write: (chunk) => chunks.push(chunk) });
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    defineTool: (opts: unknown) => opts,
    createModelBackend: () => createScriptedBackend(script.queue),
  } as unknown as ChatTurnDeps['modelGateway'];
}

function makeDeps(overrides: {
  cfg?: AppConfig;
  script?: readonly ScriptedStep[];
  cachedAnswer?: string | null;
  grader?: ((documents: string, generation: string) => Promise<'yes' | 'no'>) | null;
  appendTurn?: (...args: unknown[]) => Promise<unknown>;
  backend?: () => AgentModelBackend;
  turnResultCache?: ChatTurnDeps['turnResultCache'];
} = {}) {
  const cfg = overrides.cfg ?? makeCfg();
  const script = { queue: overrides.script ?? ([{ text: 'Hello world' }] as readonly ScriptedStep[]) };
  const cachedValue = overrides.cachedAnswer ?? null;
  const answerCache = {
    get: vi.fn(async () => cachedValue),
    set: vi.fn(async () => undefined),
    lease: {
      tryAcquire: vi.fn(async () => 'test-token'),
      release: vi.fn(async () => undefined),
    },
  };
  const appendTurn = vi.fn(overrides.appendTurn ?? (async () => ({ conversationId: 'conv-1' })));
  const answerCacheSet = answerCache.set;
  const deps: ChatTurnDeps = {
    modelGateway: overrides.backend
      ? ({
          createStream: ({ execute }: { execute: (writer: { write: (chunk: ChatChunk) => void }) => void }) =>
            new ReadableStream<ChatChunk>({
              start(controller) {
                const chunks: ChatChunk[] = [];
                execute({ write: (chunk) => chunks.push(chunk) });
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            }),
          defineTool: (opts: unknown) => opts,
          createModelBackend: () => overrides.backend!(),
        } as unknown as ChatTurnDeps['modelGateway'])
      : makeGateway(script),
    getChatModel: () => ({ modelId: 'test-chat' }),
    getChatModelId: () => 'test-chat',
    getEmbeddingModelId: () => 'emb-3',
    getRuntimeConfig: async () => cfg,
    getModelToolCapabilities: () => ({
      strictSchemas: 'native',
      inputExamples: 'native',
      outputSchemas: 'validated_locally',
      parallelCalls: true,
      toolCallRepair: 'unsupported',
      approvalHooks: 'application',
    }),
    searchChunks: (async () => ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) })) as ChatTurnDeps['searchChunks'],
    agenticSearch: (async () => {
      throw new SearchFailure('retrieval_unavailable', true, 'unused');
    }) as unknown as ChatTurnDeps['agenticSearch'],
    hallucinationGrader: () => overrides.grader ?? null,
    answerCache: answerCache as unknown as ChatTurnDeps['answerCache'],
    ...(overrides.turnResultCache ? { turnResultCache: overrides.turnResultCache } : {}),
    answerCacheKey: () => 'rag:answer:test-key',
    rateLimit: { check: vi.fn(async () => ({ ok: true as const, remaining: 29, resetMs: 60_000 })) },
    createTicket: (async () => {
      throw new Error('unused');
    }) as unknown as ChatTurnDeps['createTicket'],
    userResolver: (async () => ({ userId: 'user_test' })) as unknown as ChatTurnDeps['userResolver'],
    eventSink: { record: vi.fn(), flush: vi.fn(async () => undefined) },
    historySink: { appendTurn } as unknown as NonNullable<ChatTurnDeps['historySink']>,
    traceEnabled: false,
  };
  return { deps, answerCacheSet, appendTurn, setScript: (...steps: ScriptedStep[]) => {
    script.queue = steps;
  } };
}

function makeRequest(body: unknown, init: { signal?: AbortSignal } = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

const BODY: { turnId: string; messages: ChatInputMessage[] } = {
  turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'How do I reset my password?' }] }],
};

async function readAll(stream: ReadableStream<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } catch {
    // Stream errors (e.g. cancellation) still deliver preceding chunks first.
  }
  return out;
}

function progressOf(chunks: readonly ChatChunk[]): Array<Record<string, unknown>> {
  return chunks
    .filter((chunk): chunk is Extract<ChatChunk, { type: 'data-agent-progress' }> =>
      chunk.type === 'data-agent-progress')
    .map((chunk) => chunk.data as unknown as Record<string, unknown>);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('chatTurn WP-8 progress wiring', () => {
  it('emits no progress parts when the flag is off (byte-identical stream)', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '0');
    const { deps } = makeDeps();
    const result: ChatTurnResult = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const parts = await readAll(result.stream);
    expect(progressOf(parts)).toEqual([]);
    expect(parts).toEqual([
      { type: 'text-start', id: 'agent-3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
      {
        type: 'text-delta',
        id: 'agent-3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        delta: 'Hello world',
      },
      { type: 'text-end', id: 'agent-3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
    ]);
  });

  it('emits ordered, schema-valid progress ending in complete for a casual turn', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const { deps } = makeDeps();
    const result = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const events = progressOf(await readAll(result.stream));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(() => AgentProgressEventSchema.parse(event)).not.toThrow();
      const serialized = JSON.stringify(event);
      expect(serialized.length).toBeLessThanOrEqual(512);
      expect(serialized).not.toContain('How do I reset');
    }
    // Rate contract (max one non-terminal/second) may coalesce sub-second
    // intermediate phases on fast turns; the guarantees are first/terminal.
    const phases = events.map((event) => event.phase);
    expect(phases[0]).toBe('accepted');
    expect(phases[phases.length - 1]).toBe('complete');
    expect(phases.filter((phase) => phase === 'complete' || phase === 'degraded' || phase === 'cancelled')).toHaveLength(1);
  });

  it('emits a real searching completion with the tool call id for a slow search turn', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const { deps, setScript } = makeDeps({
      grader: async () => 'yes',
    });
    setScript(
      { toolCalls: [{ toolName: SEARCH_TOOL_NAME, args: { query: 'reset password' } }] },
      { text: 'Reset it in settings.' },
    );
    // Slow the physical search past the 1/second progress rate so the
    // completion is delivered live rather than coalesced (the started event
    // may still coalesce on fast turns; started/completed coalescing is
    // pinned by the sink unit tests).
    const searchChunks = deps.searchChunks;
    deps.searchChunks = (async (...args: Parameters<typeof searchChunks>) => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return searchChunks(...args);
    }) as ChatTurnDeps['searchChunks'];
    const result = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const events = progressOf(await readAll(result.stream));
    const searching = events.filter((event) => event.phase === 'searching');
    expect(searching.length).toBeGreaterThanOrEqual(1);
    expect(searching[searching.length - 1]?.status).toBe('completed');
    for (const event of searching) {
      expect(typeof event.callId).toBe('string');
    }
    // Normal retrieval uses no planner: no planning phase may be invented.
    // (verifying/saving intermediates may coalesce under the rate contract;
    // first/terminal/ordering are pinned by the casual test above.)
    expect(events.some((event) => event.phase === 'planning')).toBe(false);
    const phases = events.map((event) => event.phase);
    expect(phases[phases.length - 1]).toBe('complete');
  });

  it('ends in degraded for a rejected grounding decision', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const { deps, setScript } = makeDeps({
      grader: async () => 'no',
    });
    setScript(
      { toolCalls: [{ toolName: SEARCH_TOOL_NAME, args: { query: 'reset password' } }] },
      { text: 'Fabricated answer without support.' },
    );
    const result = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const events = progressOf(await readAll(result.stream));
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.phase).toBe('degraded');
  });

  it('ends in cancelled when the request aborts mid-generation', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const controller = new AbortController();
    const pendingBackend: AgentModelBackend = {
      generateStep: (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    };
    const { deps } = makeDeps({ backend: () => pendingBackend });
    const result = await chatTurn(
      { request: makeRequest(BODY, { signal: controller.signal }), userId: 'user_test' },
      deps,
    );
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const reader = result.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    const rest: ChatChunk[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rest.push(value);
      }
    } catch {
      // Cancellation terminates the stream with an error after delivery.
    } finally {
      reader.releaseLock();
    }
    const firstChunk = first.done === false ? [first.value] : [];
    const events = progressOf([...firstChunk, ...rest]);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.phase).toBe('cancelled');
  });

  it('replays progress as a stream prelude on an answer-cache hit', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const cached = JSON.stringify({
      v: 2,
      text: 'Cached answer.',
      citations: [],
      grounding: { kind: 'verified', traceVersion: 't' },
    });
    const { deps } = makeDeps({ cachedAnswer: cached });
    const result = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const parts = await readAll(result.stream);
    const events = progressOf(parts);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.phase).toBe('accepted');
    expect(events[events.length - 1]?.phase).toBe('complete');
    const firstTextIndex = parts.findIndex((part) => part.type === 'text-start');
    const lastProgressIndex = parts.map((part) => part.type).lastIndexOf('data-agent-progress');
    expect(firstTextIndex).toBeGreaterThan(-1);
    expect(lastProgressIndex).toBeGreaterThan(-1);
    expect(lastProgressIndex).toBeLessThan(firstTextIndex);
  });

  it('never leaks progress into persisted history, the answer cache, or model input', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const conversationId = 'c3f2504e-4f89-41d3-9a0c-0305e82c3301';
    const pollutedBody = {
      turnId: BODY.turnId,
      conversationId,
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [
            { type: 'text', text: 'How do I reset my password?' },
            {
              type: 'data-agent-progress',
              data: { id: 'x', phase: 'searching', status: 'started', labelCode: 'search_running', elapsedMs: 1 },
            },
          ],
        },
      ],
    };
    // Request-schema level: foreign data parts are structurally stripped
    // before they can reach history compaction or the model.
    const parsed = createChatRequestSchema().safeParse(pollutedBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(JSON.stringify(parsed.data.messages)).not.toContain('data-agent-progress');
    }
    // Production path: a verified search turn persists history and writes the
    // answer cache; neither payload may carry progress.
    const { deps, appendTurn, answerCacheSet, setScript } = makeDeps({
      grader: async () => 'yes',
    });
    setScript(
      { toolCalls: [{ toolName: SEARCH_TOOL_NAME, args: { query: 'reset password' } }] },
      { text: 'Reset it in settings.' },
    );
    const result = await chatTurn({ request: makeRequest(pollutedBody), userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    await readAll(result.stream);
    expect(appendTurn).toHaveBeenCalled();
    const persisted = JSON.stringify(appendTurn.mock.calls);
    expect(persisted).not.toContain('data-agent-progress');
    expect(answerCacheSet).toHaveBeenCalled();
    for (const call of answerCacheSet.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('data-agent-progress');
    }
  });

  it('settles safely on non-stream rejections with the flag on (idempotency conflict)', async () => {
    vi.stubEnv('WP8_SERVER_PROGRESS_ENABLED', '1');
    const conflict = JSON.stringify({
      v: 2,
      kind: 'turn-result',
      requestFingerprint: 'mismatched-fingerprint',
      fingerprintVersion: 999,
      text: 'stale',
      citations: [],
    });
    const { deps } = makeDeps({
      turnResultCache: {
        get: async () => conflict,
        set: async () => undefined,
      } as unknown as ChatTurnDeps['turnResultCache'],
    });
    const result = await chatTurn({ request: makeRequest(BODY), userId: 'user_test' }, deps);
    expect(result).toEqual({ kind: 'idempotency-conflict' });
  });
});
