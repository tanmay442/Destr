import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk } from '../../rag/search/search-types';
import { createGroundingEvidence } from '../../chat/grounding-evidence';
import type { TurnMetrics } from '../../chat/chat-turn/turn-types';
import { TurnToolLedger } from '../run-state';
import { buildCatalogToolsForTurn } from '../compat/chat-tools-compat';
import { SEARCH_TOOL_NAME } from '../tools/search-documentation';
import type { OrchestratorResult } from '../search/search-orchestrator';

function chunk(id: number, documentId: number): RetrievedChunk {
  return {
    id,
    documentId,
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: `Evidence content for document ${documentId}.`,
    chunkIndex: 0,
    chunkUid: `uid-${documentId}-0`,
    scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' },
  };
}

function metrics(): TurnMetrics {
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

function toolFactory(opts: {
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  execute: (args: never, options: unknown) => Promise<unknown>;
}) {
  return { ...opts, execute: opts.execute as (args: unknown, options?: unknown) => Promise<unknown> };
}

const receivedBudgets: (number | undefined)[] = [];

function mockStructuredSearch(physical: number) {
  return vi.fn(async (_cfg: AppConfig, query: string, opts?: { budgets?: { maxPhysicalRetrievals?: number } }) => {
    receivedBudgets.push(opts?.budgets?.maxPhysicalRetrievals);
    const items = [chunk(1, 10)];
    const result: OrchestratorResult = {
      sets: [{
        kind: 'results',
        subquestionId: 'sq-1',
        requestedQuery: query,
        executedQueries: [{ queryId: 'q-1', query }],
        results: items.map((item) => ({
          id: item.id,
          ...(item.chunkUid ? { chunkUid: item.chunkUid } : {}),
          documentId: item.documentId,
          chunkIndex: item.chunkIndex,
          subquestionId: 'sq-1',
          executedQueryIds: ['q-1'],
          content: item.content,
          source: item.source,
          scores: item.scores,
        })),
        coverage: 'sufficient',
        hasMore: false,
        degradedBy: [],
      }],
      stopReason: 'sufficient_evidence',
      plansUsed: 1,
      physicalRetrievalsUsed: physical,
      isFallback: false,
      fallbackReason: null,
      budgets: {},
      uniqueEvidenceCount: 1,
      evidenceTokens: 10,
      truncatedBy: [],
      rawPackedBySubquestion: new Map([['sq-1', items]]),
      chunkProvenance: new Map(),
    };
    return result;
  });
}

describe('turn-wide search budgets (WP-4)', () => {
  it('rejects legacy searches once the turn budget is exhausted', async () => {
    const searchChunks = vi.fn(async () => ({ ok: true, value: { chunks: [], degradedBy: [], diagnostics: {} } }) as never);
    const groundingEvidence = createGroundingEvidence();
    const built = buildCatalogToolsForTurn(
      {
        searchChunks: searchChunks as never,
        agenticSearch: (async () => { throw new Error('unused'); }) as never,
        createTicket: (async () => { throw new Error('unused'); }) as never,
        userResolver: async () => ({ name: 'N', email: 'n@example.com' }),
        rateLimit: { check: async () => ({ ok: true as const, remaining: 1, resetMs: 60_000 }) } as never,
        toolFactory: toolFactory as never,
      },
      {
        cfg: { hybridEnabled: true } as AppConfig,
        effectiveMode: 'normal',
        userId: 'user_test',
        turnId: 'turn_exhausted',
        lastUserText: 'password reset procedure steps',
        signal: new AbortController().signal,
        groundingEvidence,
        metrics: metrics(),
        ledger: new TurnToolLedger(),
        initialPhysicalUsed: 24,
      },
    );
    const search = built.tools[SEARCH_TOOL_NAME] as {
      execute: (args: unknown, options?: unknown) => Promise<unknown>;
    };
    const output = await search.execute({ query: 'password reset' }, { toolCallId: 'c1', abortSignal: new AbortController().signal }) as {
      sets: { kind: string; userSafeMessage?: string }[];
    };
    expect(searchChunks).not.toHaveBeenCalled();
    expect(output.sets[0]?.kind).toBe('error');
    expect(output.sets[0]?.userSafeMessage).toContain('budget');
  });

  it('does not charge policy rejections that run no retrieval', async () => {
    process.env.SEARCH_STRUCTURED_PLANNER_ENABLED = '1';
    const structuredSearch = mockStructuredSearch(2);
    const groundingEvidence = createGroundingEvidence();
    const built = buildCatalogToolsForTurn(
      {
        searchChunks: (async () => { throw new Error('unused'); }) as never,
        agenticSearch: (async () => { throw new Error('unused'); }) as never,
        structuredSearch: structuredSearch as never,
        createTicket: (async () => { throw new Error('unused'); }) as never,
        userResolver: async () => ({ name: 'N', email: 'n@example.com' }),
        rateLimit: { check: async () => ({ ok: true as const, remaining: 1, resetMs: 60_000 }) } as never,
        toolFactory: toolFactory as never,
      },
      {
        cfg: { hybridEnabled: true } as AppConfig,
        effectiveMode: 'normal',
        userId: 'user_test',
        turnId: 'turn_nocharge',
        lastUserText: 'password reset procedure steps',
        signal: new AbortController().signal,
        groundingEvidence,
        metrics: metrics(),
        ledger: new TurnToolLedger(),
        initialPhysicalUsed: 22,
      },
    );
    const search = built.tools[SEARCH_TOOL_NAME] as {
      execute: (args: unknown, options?: unknown) => Promise<unknown>;
    };
    await expect(search.execute({ query: '' }, { toolCallId: 'bad', abortSignal: new AbortController().signal })).rejects.toMatchObject({
      kind: 'input_validation',
    });
    await search.execute({ query: 'password reset procedure steps' }, { toolCallId: 'c1', abortSignal: new AbortController().signal });
    expect(structuredSearch).toHaveBeenCalledTimes(1);
    expect(receivedBudgets[receivedBudgets.length - 1]).toBe(2);
  });

  afterEach(() => {
    delete process.env.SEARCH_STRUCTURED_PLANNER_ENABLED;
    receivedBudgets.length = 0;
  });

  it('caps the second planner call to remaining turn physical budget', async () => {
    process.env.SEARCH_STRUCTURED_PLANNER_ENABLED = '1';
    const structuredSearch = mockStructuredSearch(20);
    const groundingEvidence = createGroundingEvidence();
    const built = buildCatalogToolsForTurn(
      {
        searchChunks: (async () => { throw new Error('legacy must not run'); }) as never,
        agenticSearch: (async () => { throw new Error('legacy must not run'); }) as never,
        structuredSearch: structuredSearch as never,
        createTicket: (async () => { throw new Error('unused'); }) as never,
        userResolver: async () => ({ name: 'N', email: 'n@example.com' }),
        rateLimit: { check: async () => ({ ok: true as const, remaining: 1, resetMs: 60_000 }) } as never,
        toolFactory: toolFactory as never,
      },
      {
        cfg: { hybridEnabled: true } as AppConfig,
        effectiveMode: 'normal',
        userId: 'user_test',
        turnId: 'turn_budget',
        lastUserText: 'password reset procedure steps',
        signal: new AbortController().signal,
        groundingEvidence,
        metrics: metrics(),
        ledger: new TurnToolLedger(),
      },
    );
    const search = built.tools[SEARCH_TOOL_NAME] as {
      execute: (args: unknown, options?: unknown) => Promise<unknown>;
    };
    const signal = new AbortController().signal;
    await search.execute({ query: 'password reset procedure steps' }, { toolCallId: 'c1', abortSignal: signal });
    await search.execute({ query: 'password reset procedure steps' }, { toolCallId: 'c2', abortSignal: signal });
    expect(structuredSearch).toHaveBeenCalledTimes(2);
    expect(receivedBudgets[0]).toBe(24);
    expect(receivedBudgets[1]).toBe(4);
  });
});
