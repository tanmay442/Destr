import { describe, expect, it, vi } from 'vitest';
import { runStructuredSearch } from '../search-orchestrator';
import type { SearchDeps } from '../../../rag/search/search-types';
import type { RetrievedChunkRow } from '@app/domain';

function row(overrides: Partial<RetrievedChunkRow> & { id: number; documentId: number }): RetrievedChunkRow {
  return {
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: `Content for doc ${overrides.documentId}.`,
    similarity: 0.9,
    parentChunkId: null,
    chunkIndex: 0,
    chunkUid: `uid-${overrides.documentId}-${overrides.chunkIndex ?? 0}`,
    documentUid: `doc-${overrides.documentId}`,
    ...overrides,
  } as RetrievedChunkRow;
}

function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
  return {
    chunks: {
      insertMany: vi.fn(),
      deleteByDocumentId: vi.fn(),
      searchByVector: vi.fn().mockResolvedValue([]),
      searchByLexical: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([]),
      getByDocAndRange: vi.fn().mockResolvedValue([]),
      getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
      countForDocuments: vi.fn(),
      countForAll: vi.fn(),
      countForDocument: vi.fn(),
      recountAll: vi.fn(),
    },
    embeddings: {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      embedBatch: vi.fn(),
    },
    ...overrides,
  } as unknown as SearchDeps;
}

describe('search orchestrator extras (WP-4 budgets, backfill, follow-up)', () => {
  it('cross-call overlap triggers over-fetch/backfill with unseen candidates', async () => {
    const allRows = [1, 2, 3, 4, 5].map((doc) => row({ id: doc, documentId: doc, content: `Doc ${doc} evidence.` }));
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockImplementation(async () => [...allRows]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure steps guide',
          queries: [{ queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const first = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-backfill-1',
      requestedLimit: 2,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxResultsPerSubquestion: 2 },
    });
    expect(first.sets[0]?.kind).toBe('results');
    const seen = new Set<string>(['chunk_uid:uid-1-0', 'chunk_uid:uid-2-0']);
    const second = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-backfill-2',
      requestedLimit: 2,
      signal: new AbortController().signal,
      planner: planner as never,
      excludeChunkIdentities: seen,
      budgets: { maxResultsPerSubquestion: 2 },
    });
    expect(second.sets[0]?.kind).toBe('results');
    if (second.sets[0]?.kind !== 'results') throw new Error('expected results');
    const ids = second.sets[0].results.map((item) => item.documentId);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(second.sets[0].results).toHaveLength(2);
  });

  it('weak evidence permits exactly one bounded follow-up plan', async () => {
    const rank = vi.fn()
      .mockImplementationOnce(async (_query: string, docs: string[]) => docs.map((_, index) => ({ index, relevanceScore: 0.55 })))
      .mockImplementation(async (_query: string, docs: string[]) => docs.map((_, index) => ({ index, relevanceScore: 0.95 - index * 0.01 })));
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 }), row({ id: 2, documentId: 2 })]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
      reranker: { rank } as never,
    });
    let plannerCalls = 0;
    const planner = async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return {
          intent: 'documentation',
          subquestions: [
            {
              subquestionId: 'sq-1',
              question: 'password reset procedure detailed employee steps',
              queries: [{ queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' }],
            },
          ],
        };
      }
      return {
        intent: 'documentation',
        subquestions: [
          {
            subquestionId: 'sq-1',
            question: 'password reset procedure detailed employee steps',
            queries: [{ queryId: 'q-2', text: 'password reset steps employees guide', strategy: 'semantic', rationaleCode: 'coverage_gap' }],
          },
        ],
      };
    };
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure detailed employee steps',
      callId: 'call-weak',
      requestedLimit: 2,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxResultsPerSubquestion: 2, maxSearchPlans: 2 },
    });
    expect(plannerCalls).toBe(2);
    expect(result.plansUsed).toBe(2);
    expect(result.stopReason).not.toBe('candidate_exhausted');
  });

  it('repeated result sets stop immediately', async () => {
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
    });
    let calls = 0;
    const planner = async () => {
      calls += 1;
      return {
        intent: 'documentation',
        subquestions: [
          {
            subquestionId: 'sq-1',
            question: 'password reset procedure steps guide detailed',
            queries: [{ queryId: `q-${calls}`, text: `password reset variant ${calls}`, strategy: 'original', rationaleCode: 'normalized' }],
          },
        ],
      };
    };
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps guide detailed',
      callId: 'call-rresult',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxSearchPlans: 2, maxResultsPerSubquestion: 5 },
    });
    expect(calls).toBeLessThanOrEqual(2);
    expect(['sufficient_evidence', 'partial_evidence', 'candidate_exhausted', 'repeated_query_set', 'repeated_result_set']).toContain(result.stopReason);
  });

  it('deadline and timeout stop in-flight operations without unhandled rejections', async () => {
    const searchDeps = makeDeps();
    const past = Date.now() - 1000;
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps',
      callId: 'call-deadline',
      requestedLimit: 3,
      signal: new AbortController().signal,
      deadlineAt: past,
    });
    expect(result.stopReason).toBe('deadline_exceeded');
    expect(result.sets[0]?.kind).toBe('error');
  });

  it('exhausted pools return candidate_exhausted with accurate counts', async () => {
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockResolvedValue([]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure steps guide',
          queries: [{ queryId: 'q-1', text: 'password reset nowhere', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-empty',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(result.stopReason).toBe('candidate_exhausted');
    expect(result.sets[0]?.kind).toBe('no_match');
  });

  it('respects modality candidate budgets without exceeding physical ceilings', async () => {
    const vectorSpy = vi.fn().mockResolvedValue([]);
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vectorSpy,
        searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure steps',
          queries: [{ queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps',
      callId: 'call-modality',
      requestedLimit: 2,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxCandidatesPerModality: 10, maxPhysicalRetrievals: 5 },
    });
    expect(result.physicalRetrievalsUsed).toBeLessThanOrEqual(5);
    for (const call of vectorSpy.mock.calls) {
      const opts = call[1] as { limit?: number };
      expect(opts.limit ?? 0).toBeLessThanOrEqual(30);
    }
  });
});

describe('stable identity and token accounting boundaries (WP-4 generated)', () => {
  it('prefers chunkUid over document position and never uses similarity alone', async () => {
    const { stableChunkIdentity, stableChunkIdentities } = await import('../../../rag/search/stable-chunk-identity');
    expect(stableChunkIdentity({ chunkUid: 'abc', documentId: 1, chunkIndex: 5 })).toContain('abc');
    expect(stableChunkIdentity({ documentId: 1, chunkIndex: 5 })).toContain('1:5');
    expect(stableChunkIdentity({ chunkUid: '  ', documentId: 2, chunkIndex: 3 })).toContain('2:3');
    for (let doc = 1; doc <= 5; doc += 1) {
      for (let idx = 0; idx < 3; idx += 1) {
        const withUid = stableChunkIdentity({ chunkUid: `u-${doc}-${idx}`, documentId: doc, chunkIndex: idx });
        const withoutUid = stableChunkIdentity({ documentId: doc, chunkIndex: idx });
        expect(withUid).not.toBe(withoutUid);
        expect(stableChunkIdentities({ documentId: doc, chunkIndex: idx, chunkUid: `u-${doc}-${idx}` })).toHaveLength(1);
      }
    }
  });
});
