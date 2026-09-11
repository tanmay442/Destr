import { describe, expect, it, vi } from 'vitest';
import { ok } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import type { RetrievedChunk } from '../../../rag/search/search-types';
import {
  createDefaultBudget,
  createInMemoryTraceWriter,
  type AgentToolContext,
} from '../../tool-contract';
import { InMemoryToolApprovalPolicy } from '../../tool-approval';
import { createSearchDocumentationTool } from '../../tools/search-documentation';
import type { OrchestratorResult } from '../search-orchestrator';

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: 1,
    documentId: 10,
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: 'Planner evidence content.',
    chunkIndex: 0,
    chunkUid: 'uid-10-0',
    scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' },
    ...overrides,
  };
}

function makeContext(): AgentToolContext {
  return {
    actor: { userId: 'user_test' },
    turnId: 'turn_test',
    signal: new AbortController().signal,
    budget: createDefaultBudget({ maxTotalToolCalls: 10 }),
    evidence: {
      seenChunkKeys: new Set<string>(),
      addEvidence: (chunks) => chunks,
    },
    trace: createInMemoryTraceWriter(),
    approvals: new InMemoryToolApprovalPolicy({ explicitTicketRequest: false, userId: 'user_test', turnId: 'turn_test' }),
  };
}

function orchestratorResult(chunks: RetrievedChunk[]): OrchestratorResult {
  return {
    sets: [
      {
        kind: 'results',
        subquestionId: 'sq-1',
        requestedQuery: 'password reset',
        executedQueries: [{ queryId: 'q-1', query: 'password reset' }],
        results: chunks.map((item) => ({
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
      },
    ],
    stopReason: 'sufficient_evidence',
    plansUsed: 1,
    physicalRetrievalsUsed: 1,
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

function orchestratorResultShared(entries: { chunk: RetrievedChunk; queryIds: string[] }[]): OrchestratorResult {
  const base = orchestratorResult(entries.map((entry) => entry.chunk));
  const set = base.sets[0];
  if (!set || set.kind !== 'results') throw new Error('expected results set');
  const byId = new Map(entries.map((entry) => [entry.chunk.id, entry.queryIds]));
  return {
    ...base,
    sets: [{
      ...set,
      executedQueries: [
        { queryId: 'q-1', query: 'password reset' },
        { queryId: 'q-2', query: 'password reset steps' },
      ],
      results: set.results.map((item) => ({
        ...item,
        executedQueryIds: [...(byId.get(item.id) ?? ['q-1'])].sort(),
      })),
    }],
  };
}

describe('searchDocumentation planner path (WP-4 tool integration)', () => {
  it('uses structured planner results with provenance when enabled', async () => {
    const structuredSearch = vi.fn(async () => orchestratorResult([chunk()]));
    const tool = createSearchDocumentationTool({
      searchChunks: (async () => {
        throw new Error('legacy path must not run when planner is enabled');
      }) as never,
      agenticSearch: (async () => {
        throw new Error('legacy agentic path must not run when planner is enabled');
      }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: structuredSearch as never,
      plannerEnabled: true,
    });
    const output = await tool.create(makeContext())({ query: 'password reset' }, { callId: 'call-planner', signal: new AbortController().signal });
    expect(structuredSearch).toHaveBeenCalledTimes(1);
    expect(output.sets[0]?.kind).toBe('results');
    if (output.sets[0]?.kind !== 'results') throw new Error('expected results');
    expect(output.sets[0].subquestionId).toBe('sq-1');
    expect(output.callId).toBe('call-planner');
    expect(output.uniqueEvidenceAdded).toBe(1);
  });

  it('shadow comparison returns normal results unchanged', async () => {
    const searchChunks = vi.fn(async () => ok({ chunks: [chunk({ content: 'Normal path.' })], degradedBy: [], diagnostics: { hasMore: false } as never }) as never);
    const structuredSearch = vi.fn(async () => orchestratorResult([chunk({ content: 'Shadow planner.' })]));
    const tool = createSearchDocumentationTool({
      searchChunks: searchChunks as never,
      agenticSearch: (async () => {
        throw new Error('unused');
      }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: structuredSearch as never,
      plannerEnabled: false,
      shadowEnabled: true,
    });
    const output = await tool.create(makeContext())({ query: 'password reset' }, { callId: 'call-shadow', signal: new AbortController().signal });
    expect(searchChunks).toHaveBeenCalled();
    expect(structuredSearch).toHaveBeenCalled();
    if (output.sets[0]?.kind !== 'results') throw new Error('expected results');
    expect(output.sets[0].results[0]?.content).toContain('Normal path');
  });

  it('returns normal results without waiting for a slow shadow comparison', async () => {
    let releaseShadow: (() => void) | undefined;
    const structuredSearch = vi.fn(() => new Promise<OrchestratorResult>((resolve) => {
      releaseShadow = () => { resolve(orchestratorResult([chunk({ content: 'Late shadow.' })])); };
    }));
    const tool = createSearchDocumentationTool({
      searchChunks: vi.fn(async () => ok({
        chunks: [chunk({ content: 'Immediate normal result.' })],
        degradedBy: [],
        diagnostics: { hasMore: false } as never,
      }) as never) as never,
      agenticSearch: (async () => { throw new Error('unused'); }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: structuredSearch as never,
      plannerEnabled: false,
      shadowEnabled: true,
    });

    const output = await tool.create(makeContext())(
      { query: 'password reset' },
      { callId: 'call-slow-shadow', signal: new AbortController().signal },
    );
    expect(output.sets[0]?.kind).toBe('results');
    expect(structuredSearch).toHaveBeenCalledTimes(1);
    releaseShadow?.();
  });

  it('preserves per-chunk multi-variant provenance through serialization', async () => {
    const first = chunk({ id: 1, documentId: 10, chunkUid: 'uid-10-0', content: 'First evidence.' });
    const second = chunk({ id: 2, documentId: 11, chunkUid: 'uid-11-0', content: 'Second evidence.' });
    const structuredSearch = vi.fn(async () => orchestratorResultShared([
      { chunk: first, queryIds: ['q-1'] },
      { chunk: second, queryIds: ['q-1', 'q-2'] },
    ]));
    const tool = createSearchDocumentationTool({
      searchChunks: (async () => { throw new Error('unused'); }) as never,
      agenticSearch: (async () => { throw new Error('unused'); }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: structuredSearch as never,
      plannerEnabled: true,
    });
    const output = await tool.create(makeContext())({ query: 'password reset' }, { callId: 'call-prov', signal: new AbortController().signal });
    expect(output.sets[0]?.kind).toBe('results');
    if (output.sets[0]?.kind !== 'results') throw new Error('expected results');
    const byContent = new Map(output.sets[0].results.map((item) => [item.documentId, item.executedQueryIds]));
    expect(byContent.get(10)).toEqual(['q-1']);
    expect(byContent.get(11)).toEqual(['q-1', 'q-2']);
    const validIds = new Set(output.sets[0].executedQueries.map((entry) => entry.queryId));
    for (const item of output.sets[0].results) {
      for (const queryId of item.executedQueryIds) expect(validIds.has(queryId)).toBe(true);
    }
  });

  it('preserves shared-chunk multi-subquestion provenance through the tool boundary', async () => {
    const shared = chunk();
    const base = orchestratorResult([shared]);
    const first = base.sets[0];
    if (!first || first.kind !== 'results') throw new Error('expected results');
    const structuredSearch = vi.fn(async (): Promise<OrchestratorResult> => ({
      ...base,
      sets: [
        {
          ...first,
          subquestionId: 'sq-account',
          executedQueries: [{ queryId: 'q-account', query: 'account policy' }],
          results: first.results.map((item) => ({
            ...item,
            subquestionId: 'sq-account',
            executedQueryIds: ['q-account'],
            provenance: { subquestionIds: ['sq-account', 'sq-refund'], queryIds: ['q-account', 'q-refund'] },
          })),
        },
        {
          kind: 'no_match',
          subquestionId: 'sq-refund',
          requestedQuery: 'refund policy',
          attemptedQueries: ['refund policy'],
          reason: 'filtered_duplicates',
          ticketEligible: false,
        },
      ],
      rawPackedBySubquestion: new Map([['sq-account', [shared]], ['sq-refund', []]]),
      chunkProvenance: new Map([[
        'chunk_uid:uid-10-0',
        { subquestionIds: ['sq-account', 'sq-refund'], queryIds: ['q-account', 'q-refund'] },
      ]]),
    }));
    const tool = createSearchDocumentationTool({
      searchChunks: (async () => { throw new Error('unused'); }) as never,
      agenticSearch: (async () => { throw new Error('unused'); }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: structuredSearch as never,
      plannerEnabled: true,
    });
    const output = await tool.create(makeContext())(
      { query: 'account and refund policy' },
      { callId: 'call-shared-provenance', signal: new AbortController().signal },
    );
    const resultSet = output.sets.find((set) => set.kind === 'results');
    if (!resultSet || resultSet.kind !== 'results') throw new Error('expected results');
    expect(resultSet.results[0]?.provenance).toEqual({
      subquestionIds: ['sq-account', 'sq-refund'],
      queryIds: ['q-account', 'q-refund'],
    });
  });

  it('infrastructure failures remain typed errors and never become no_match', async () => {
    const { SearchFailure } = await import('../../../rag/search/search-contract');
    const failing = vi.fn(async () => ({
      sets: [
        { kind: 'error', subquestionId: 'sq-1', requestedQuery: 'q', attemptedQueries: ['q'], code: 'retrieval_unavailable', retryable: true, userSafeMessage: 'Safe.' },
      ],
      stopReason: 'candidate_exhausted',
      plansUsed: 1,
      physicalRetrievalsUsed: 1,
      isFallback: false,
      fallbackReason: null,
      budgets: {},
      uniqueEvidenceCount: 0,
      evidenceTokens: 0,
      truncatedBy: [],
      rawPackedBySubquestion: new Map(),
      chunkProvenance: new Map(),
    }));
    void SearchFailure;
    const tool = createSearchDocumentationTool({
      searchChunks: (async () => {
        throw new Error('unused');
      }) as never,
      agenticSearch: (async () => {
        throw new Error('unused');
      }) as never,
      cfg: {} as AppConfig,
      effectiveMode: 'normal',
      structuredSearch: failing as never,
      plannerEnabled: true,
    });
    const output = await tool.create(makeContext())({ query: 'q' }, { callId: 'call-err', signal: new AbortController().signal });
    expect(output.sets[0]?.kind).toBe('error');
    expect(output.sets[0] as Record<string, unknown>).not.toHaveProperty('ticketEligible');
  });
});
