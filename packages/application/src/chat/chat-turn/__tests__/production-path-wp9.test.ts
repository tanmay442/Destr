import { describe, it, expect, vi, afterEach } from 'vitest';
import { ok } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk, RetrievalDiagnostics } from '../../../rag/search';
import { chatTurn } from '../turn';
import type { ChatTurnDeps, TurnMetrics } from '../turn-types';
import {
  createSearchDocumentationTool,
  SEARCH_TOOL_NAME,
} from '../../../agent/tools/search-documentation';
import { buildCatalogToolsForTurn } from '../../../agent/turn-tools';
import { createGroundingEvidence } from '../../grounding-evidence';
import { TurnToolLedger } from '../../../agent/run-state';
import { createAgentRunBudget } from '../../../agent/agent-budget';
import { createInMemoryTraceWriter, type AgentToolContext } from '../../../agent/tool-contract';
import { InMemoryToolApprovalPolicy } from '../../../agent/tool-approval';
import {
  createScriptedBackend,
  type ScriptedStep,
} from '../../../agent/scripted-model';
import type { ChatChunk } from '../../chat-chunks';
import type { OrchestratorResult } from '../../../agent/search/search-orchestrator';

/**
 * WP-9 single production path (production-path proof).
 *
 * (a) The turn deps surface exposes `structuredSearch` and no
 *     `agenticSearch`; catalog tools built without any agenticSearch key
 *     route agentic -> orchestrator mock and normal -> searchChunks.
 * (b) Removed experiment/rollback flags have no effect on routing or the
 *     release policy.
 * (c) The searchDocumentation tool constructed without an agenticSearch dep
 *     executes in both modes.
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

function orchestratorOk(query: string, chunks: RetrievedChunk[] = [CHUNK]): OrchestratorResult {
  return {
    sets: [{
      kind: 'results',
      subquestionId: 'sq-1',
      requestedQuery: query,
      executedQueries: [{ queryId: 'q-1', query }],
      results: chunks.map((chunk) => ({
        id: chunk.id,
        ...(chunk.chunkUid ? { chunkUid: chunk.chunkUid } : {}),
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        subquestionId: 'sq-1',
        executedQueryIds: ['q-1'],
        content: chunk.content,
        source: chunk.source,
        ...(chunk.title ? { documentTitle: chunk.title } : {}),
        ...(chunk.sectionTitle ? { section: chunk.sectionTitle } : {}),
        scores: chunk.scores,
      })),
      coverage: 'sufficient',
      hasMore: false,
      degradedBy: [],
    }],
    stopReason: 'sufficient_evidence',
    plansUsed: 1,
    physicalRetrievalsUsed: 2,
    isFallback: false,
    fallbackReason: null,
    budgets: {},
    uniqueEvidenceCount: chunks.length,
    evidenceTokens: 10,
    truncatedBy: [],
    rawPackedBySubquestion: new Map([['sq-1', chunks]]),
    chunkProvenance: new Map(),
  };
}

function makeMetrics(): TurnMetrics {
  return {
    retrieveMs: 0,
    prefetchMs: null,
    prefetchStatus: 'disabled',
    firstTokenMs: null,
    hallucinationMs: null,
    hitCount: null,
    maxRetrievalScores: {},
    searchResultStates: [],
    ticketCreated: false,
    ticketId: null,
    rewritten: false,
    reformulationCount: 0,
  };
}

function makeToolContext(): AgentToolContext {
  return {
    actor: { userId: 'user_test' },
    turnId: 'turn_test',
    signal: new AbortController().signal,
    budget: createAgentRunBudget({ nowMs: Date.now(), overrides: { maxTotalToolCalls: 10 } }),
    evidence: {
      seenChunkKeys: new Set<string>(),
      addEvidence: (chunks) => chunks,
    },
    trace: createInMemoryTraceWriter(),
    approvals: new InMemoryToolApprovalPolicy({ explicitTicketRequest: false, userId: 'user_test', turnId: 'turn_test' }),
  };
}

const REMOVED_FLAGS = [
  'TOOL_CATALOG_ENABLED',
  'SEARCH_PLANNER_SHADOW',
  'SEARCH_QUERY2DOC_ENABLED',
  'SUPPORT_AGENT_ENABLED',
  'GROUNDED_RELEASE_ENABLED',
] as const;

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of REMOVED_FLAGS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
    delete savedEnv[key];
  }
});

function setRemovedFlags(): void {
  savedEnv.TOOL_CATALOG_ENABLED = process.env.TOOL_CATALOG_ENABLED;
  savedEnv.SEARCH_PLANNER_SHADOW = process.env.SEARCH_PLANNER_SHADOW;
  savedEnv.SEARCH_QUERY2DOC_ENABLED = process.env.SEARCH_QUERY2DOC_ENABLED;
  savedEnv.SUPPORT_AGENT_ENABLED = process.env.SUPPORT_AGENT_ENABLED;
  savedEnv.GROUNDED_RELEASE_ENABLED = process.env.GROUNDED_RELEASE_ENABLED;
  process.env.TOOL_CATALOG_ENABLED = '0';
  process.env.SEARCH_PLANNER_SHADOW = '1';
  process.env.SEARCH_QUERY2DOC_ENABLED = '1';
  process.env.SUPPORT_AGENT_ENABLED = '0';
  process.env.GROUNDED_RELEASE_ENABLED = '0';
}

describe('WP-9 production path (no agenticSearch, no experiment flags)', () => {
  it('exposes structuredSearch and no agenticSearch; catalog routes agentic->orchestrator and normal->searchChunks', async () => {
    const searchChunks = vi.fn(async () =>
      ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) }),
    );
    const structuredSearchMock = vi.fn(async (_cfg: AppConfig, query: string) => orchestratorOk(query));
    const structuredSearch = structuredSearchMock as unknown as NonNullable<ChatTurnDeps['structuredSearch']>;
    const compatDeps = {
      searchChunks,
      structuredSearch,
      createTicket: (async () => {
        throw new Error('unused');
      }) as never,
      userResolver: (async () => ({ name: 'n', email: 'e@example.com' })) as never,
      rateLimit: { check: vi.fn(async () => ({ ok: true as const, remaining: 29, resetMs: 60_000 })) } as never,
      toolFactory: (opts: unknown) => opts,
    };
    expect('agenticSearch' in compatDeps).toBe(false);
    expect(typeof compatDeps.structuredSearch).toBe('function');

    const controller = new AbortController();
    const agentic = buildCatalogToolsForTurn(
      compatDeps,
      {
        cfg: makeCfg({ retrievalMode: 'agentic' }),
        effectiveMode: 'agentic',
        userId: 'user_test',
        turnId: 'turn-1',
        lastUserText: 'vague',
        signal: controller.signal,
        groundingEvidence: createGroundingEvidence(),
        metrics: makeMetrics(),
        ledger: new TurnToolLedger(),
        budgetDeadlineInMs: 50_000,
      },
    );
    const agenticModeSearchTool = agentic.executionTools[SEARCH_TOOL_NAME];
    expect(agenticModeSearchTool).toBeDefined();
    const agenticOut = (await agenticModeSearchTool!.execute({ query: 'vague' }, {
      toolCallId: 'call-agentic-1',
      abortSignal: controller.signal,
    })) as { sets: Array<{ kind: string; requestedQuery?: string }> };
    expect(structuredSearch).toHaveBeenCalledTimes(1);
    expect(structuredSearch).toHaveBeenCalledWith(
      expect.anything(),
      'vague',
      expect.objectContaining({ limit: 3 }),
    );
    expect(searchChunks).not.toHaveBeenCalled();
    expect(agenticOut.sets[0]?.kind).toBe('results');
    expect(agenticOut.sets[0]?.requestedQuery).toBe('vague');

    searchChunks.mockClear();
    structuredSearchMock.mockClear();
    const normal = buildCatalogToolsForTurn(
      compatDeps,
      {
        cfg: makeCfg({ retrievalMode: 'normal' }),
        effectiveMode: 'normal',
        userId: 'user_test',
        turnId: 'turn-2',
        lastUserText: 'plain',
        signal: controller.signal,
        groundingEvidence: createGroundingEvidence(),
        metrics: makeMetrics(),
        ledger: new TurnToolLedger(),
        budgetDeadlineInMs: 50_000,
      },
    );
    const normalSearchTool = normal.executionTools[SEARCH_TOOL_NAME];
    expect(normalSearchTool).toBeDefined();
    const normalOut = (await normalSearchTool!.execute({ query: 'plain' }, {
      toolCallId: 'call-normal-1',
      abortSignal: controller.signal,
    })) as { sets: Array<{ kind: string }> };
    expect(searchChunks).toHaveBeenCalledTimes(1);
    expect(structuredSearch).not.toHaveBeenCalled();
    expect(normalOut.sets[0]?.kind).toBe('results');
  });

  it('removed flags do not change catalog tool routing', async () => {
    setRemovedFlags();
    const searchChunks = vi.fn(async () =>
      ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) }),
    );
    const structuredSearchMock = vi.fn(async (_cfg: AppConfig, query: string) => orchestratorOk(query));
    const structuredSearch = structuredSearchMock as unknown as NonNullable<ChatTurnDeps['structuredSearch']>;
    const controller = new AbortController();
    const baseDeps = {
      searchChunks,
      structuredSearch,
      createTicket: (async () => {
        throw new Error('unused');
      }) as never,
      userResolver: (async () => ({ name: 'n', email: 'e@example.com' })) as never,
      rateLimit: { check: vi.fn(async () => ({ ok: true as const, remaining: 29, resetMs: 60_000 })) } as never,
      toolFactory: (opts: unknown) => opts,
    };
    const agentic = buildCatalogToolsForTurn(baseDeps, {
      cfg: makeCfg({ retrievalMode: 'agentic' }),
      effectiveMode: 'agentic',
      userId: 'user_test',
      turnId: 'turn-flags-1',
      lastUserText: 'vague',
      signal: controller.signal,
      groundingEvidence: createGroundingEvidence(),
      metrics: makeMetrics(),
      ledger: new TurnToolLedger(),
      budgetDeadlineInMs: 50_000,
    });
    await agentic.executionTools[SEARCH_TOOL_NAME]!.execute({ query: 'vague' }, {
      toolCallId: 'call-flags-agentic',
      abortSignal: controller.signal,
    });
    expect(structuredSearchMock).toHaveBeenCalledTimes(1);
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it('removed flags do not change turn behavior or the release policy', async () => {
    setRemovedFlags();
    const script: { queue: readonly ScriptedStep[] } = {
      queue: [
        { toolCalls: [{ toolName: SEARCH_TOOL_NAME, args: { query: 'vague' } }] },
        { text: 'grounded answer' },
      ],
    };
    const gateway = {
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
    const searchChunks = vi.fn(async () =>
      ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) }),
    );
    const structuredSearch = vi.fn(async (_cfg: AppConfig, query: string) => orchestratorOk(query)) as unknown as NonNullable<ChatTurnDeps['structuredSearch']>;
    const grader = vi.fn(async () => 'yes' as const);
    const record = vi.fn();
    const deps: ChatTurnDeps = {
      modelGateway: gateway,
      getChatModel: () => ({ modelId: 'test-chat' }),
      getChatModelId: () => 'test-chat',
      getEmbeddingModelId: () => 'emb-3',
      getRuntimeConfig: async () => makeCfg({ retrievalMode: 'agentic' }),
      searchChunks: searchChunks as ChatTurnDeps['searchChunks'],
      structuredSearch,
      hallucinationGrader: () => grader,
      answerCache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        lease: { tryAcquire: vi.fn(async () => 'tok'), release: vi.fn(async () => undefined) },
      } as unknown as ChatTurnDeps['answerCache'],
      answerCacheKey: () => 'rag:answer:test-key',
      rateLimit: { check: vi.fn(async () => ({ ok: true as const, remaining: 29, resetMs: 60_000 })) },
      createTicket: (async () => {
        throw new Error('unused');
      }) as unknown as ChatTurnDeps['createTicket'],
      userResolver: (async () => ({ userId: 'user_test' })) as unknown as ChatTurnDeps['userResolver'],
      eventSink: { record, flush: vi.fn(async () => undefined) },
      historySink: { appendTurn: vi.fn(async () => ({ conversationId: 'conv-1' })) } as unknown as NonNullable<ChatTurnDeps['historySink']>,
      traceEnabled: false,
    };
    expect('agenticSearch' in deps).toBe(false);

    const request = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'vague' }] }],
      }),
    });
    const result = await chatTurn({ request, userId: 'user_test' }, deps);
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const parts: unknown[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    // Planner path stays active despite TOOL_CATALOG_ENABLED=0 / shadow / query2doc flags.
    expect(structuredSearch).toHaveBeenCalledTimes(1);
    expect(searchChunks).not.toHaveBeenCalled();
    // Release policy still runs despite GROUNDED_RELEASE_ENABLED=0 / SUPPORT_AGENT_ENABLED=0.
    expect(grader).toHaveBeenCalledTimes(1);
    expect(parts.some((p) => (p as { type: string }).type === 'data-citation')).toBe(true);
    const event = record.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(event?.mode).toBe('agentic');
  });

  it('searchDocumentation tool without an agenticSearch dep executes in both modes', async () => {
    const cfg = makeCfg();
    const directSearch = vi.fn(async () =>
      ok({ chunks: [CHUNK], degradedBy: [], diagnostics: testDiagnostics(1) }),
    );
    const call = { callId: 'call-direct', signal: new AbortController().signal };

    const normalDeps = {
      searchChunks: directSearch,
      cfg,
      effectiveMode: 'normal' as const,
    };
    expect('agenticSearch' in normalDeps).toBe(false);
    const normalTool = createSearchDocumentationTool(normalDeps as never);
    const normalOut = await normalTool.create(makeToolContext())({ query: 'password reset' }, call);
    expect(directSearch).toHaveBeenCalledTimes(1);
    expect(normalOut.sets[0]?.kind).toBe('results');

    directSearch.mockClear();
    const agenticFallbackDeps = {
      searchChunks: directSearch,
      cfg,
      effectiveMode: 'agentic' as const,
    };
    expect('agenticSearch' in agenticFallbackDeps).toBe(false);
    const fallbackTool = createSearchDocumentationTool(agenticFallbackDeps as never);
    const fallbackOut = await fallbackTool.create(makeToolContext())({ query: 'password reset' }, call);
    expect(directSearch).toHaveBeenCalledTimes(1);
    expect(fallbackOut.sets[0]?.kind).toBe('results');

    directSearch.mockClear();
    const plannerSearch = vi.fn(async () => orchestratorOk('password reset'));
    const plannerTool = createSearchDocumentationTool({
      searchChunks: directSearch,
      cfg,
      effectiveMode: 'agentic',
      structuredSearch: plannerSearch as never,
    });
    const plannerOut = await plannerTool.create(makeToolContext())({ query: 'password reset' }, call);
    expect(plannerSearch).toHaveBeenCalledTimes(1);
    expect(directSearch).not.toHaveBeenCalled();
    expect(plannerOut.sets[0]?.kind).toBe('results');
  });
});
