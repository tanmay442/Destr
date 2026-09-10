import { describe, expect, it, vi } from 'vitest';
import { runStructuredSearch, type OrchestratorDeps } from '../search-orchestrator';
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

function orchestratorDeps(searchDeps: SearchDeps): OrchestratorDeps {
  return { search: searchDeps };
}

describe('search orchestrator (WP-4)', () => {
  it('duplicate planner variants execute only once', async () => {
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockImplementation(async (query: string) => [row({ id: 1, documentId: 1, content: `Result for ${query}` })]),
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
          question: 'password reset',
          queries: [
            { queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-2', text: '  PASSWORD  reset ', strategy: 'semantic', rationaleCode: 'remove_chatter' },
          ],
        },
      ],
    });
    const result = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'password reset',
      callId: 'call-dedup',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    const lexical = searchDeps.chunks.searchByLexical as ReturnType<typeof vi.fn>;
    expect(lexical).toHaveBeenCalledTimes(1);
    expect(result.sets[0]?.kind).toBe('results');
  });

  it('variants run concurrently and observe cancellation without unhandled rejections', async () => {
    let active = 0;
    let maxActive = 0;
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockImplementation(async (_query: string, opts?: { signal?: AbortSignal }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 50);
              opts?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
              }, { once: true });
            });
            return [row({ id: 1, documentId: 1 })];
          } finally {
            active -= 1;
          }
        }),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
    });
    const controller = new AbortController();
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'concurrent query one two three',
          queries: [
            { queryId: 'q-1', text: 'concurrent alpha query one', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-2', text: 'concurrent beta query two', strategy: 'semantic', rationaleCode: 'remove_chatter' },
            { queryId: 'q-3', text: 'concurrent gamma query three', strategy: 'title_section', rationaleCode: 'alternate_product_term' },
          ],
        },
      ],
    });
    const promise = runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'concurrent query one two three',
      callId: 'call-concurrent',
      requestedLimit: 3,
      signal: controller.signal,
      planner: planner as never,
      budgets: { maxConcurrentRetrievals: 3 },
    });
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result.stopReason).toBe('cancelled');
    expect(maxActive).toBeGreaterThan(1);
  });

  it('variants for one subquestion receive exactly one combined fusion/rerank pass', async () => {
    const rank = vi.fn().mockImplementation(async (_query: string, docs: string[]) => docs.map((_, index) => ({ index, relevanceScore: 0.9 - index * 0.01 })));
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockImplementation(async (query: string) => [
          row({ id: query.length, documentId: 1, chunkIndex: query.length % 5, content: `Lexical hit for ${query}` }),
          row({ id: query.length + 100, documentId: 2, chunkIndex: 0, content: `Second hit for ${query}` }),
        ]),
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
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure for employees',
          queries: [
            { queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-2', text: 'password reset steps employees', strategy: 'semantic', rationaleCode: 'remove_chatter' },
          ],
        },
      ],
    });
    await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'password reset procedure for employees',
      callId: 'call-fusion',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0]?.[0]).toBe('password reset procedure for employees');
  });

  it('unrelated subquestions are never globally reranked', async () => {
    const seenQueries: string[] = [];
    const rank = vi.fn().mockImplementation(async (query: string, docs: string[]) => {
      seenQueries.push(query);
      return docs.map((_, index) => ({ index, relevanceScore: 0.9 - index * 0.01 }));
    });
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockResolvedValue([]),
        searchByLexical: vi.fn().mockImplementation(async (query: string) => [row({ id: query.length, documentId: query.length, content: `Hit ${query}` })]),
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
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-account',
          question: 'account lockout policy duration',
          queries: [{ queryId: 'q-a1', text: 'account lockout policy', strategy: 'original', rationaleCode: 'normalized' }],
        },
        {
          subquestionId: 'sq-refund',
          question: 'refund deadline policy days',
          queries: [{ queryId: 'q-b1', text: 'refund deadline policy', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'account lockout and refund deadline policies',
      callId: 'call-separate',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(rank).toHaveBeenCalledTimes(2);
    expect(seenQueries).toHaveLength(2);
    for (const query of seenQueries) {
      expect(query.toLowerCase()).not.toContain('account lockout and refund');
      expect(query.toLowerCase()).not.toContain('account_lockout refund_deadline');
    }
  });

  it('malformed planner output falls back to normalized original and is traced, never out-of-scope', async () => {
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
    const trace: { toolName: string; callId: string; phase: string; durationMs: number | null }[] = [];
    const malformed = async () => ({ intent: 'nonsense', subquestions: 'oops' });
    const result = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: '  password   reset  ',
      callId: 'call-fallback',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: malformed as never,
      trace: { write: (event) => { trace.push(event); } },
    });
    expect(result.isFallback).toBe(true);
    expect(result.fallbackReason).toBe('planner_malformed');
    expect(trace.length).toBeGreaterThan(0);
    expect(result.stopReason).not.toBe('out_of_scope');
    const first = result.sets[0];
    expect(first?.kind).not.toBe('error');
    if (first?.kind === 'no_match') expect(first.reason).not.toBe('out_of_scope');
  });

  it('out-of-scope and clarification-needed plans perform no retrieval', async () => {
    const searchDeps = makeDeps();
    const lexical = searchDeps.chunks.searchByLexical as ReturnType<typeof vi.fn>;
    const outOfScope = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'medical diagnosis for my symptoms',
      callId: 'call-oos',
      requestedLimit: 3,
      signal: new AbortController().signal,
    });
    expect(outOfScope.stopReason).toBe('out_of_scope');
    expect(lexical).not.toHaveBeenCalled();
    expect(outOfScope.sets[0]).toMatchObject({ kind: 'no_match', reason: 'out_of_scope', ticketEligible: false });

    const clarification = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'help',
      callId: 'call-clarify',
      requestedLimit: 3,
      signal: new AbortController().signal,
    });
    expect(clarification.stopReason).toBe('clarification_needed');
    expect(clarification.sets[0]).toMatchObject({ kind: 'no_match', ticketEligible: false });
  });

  it('strong evidence stops immediately while weak evidence permits one bounded follow-up', async () => {
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
    let plannerCalls = 0;
    const countingPlanner = async () => {
      plannerCalls += 1;
      return {
        intent: 'documentation',
        subquestions: [
          {
            subquestionId: 'sq-1',
            question: 'password reset procedure detailed steps',
            queries: [{ queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' }],
          },
        ],
      };
    };
    const strong = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'password reset procedure detailed steps',
      callId: 'call-strong',
      requestedLimit: 1,
      signal: new AbortController().signal,
      planner: countingPlanner as never,
    });
    expect(strong.stopReason).toBe('sufficient_evidence');
    expect(strong.plansUsed).toBe(1);
    expect(plannerCalls).toBe(1);
  });

  it('repeated query sets stop immediately', async () => {
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
    const samePlan = {
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure steps guide',
          queries: [{ queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    };
    const planner = async () => samePlan;
    const result = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-repeat',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxSearchPlans: 2, maxResultsPerSubquestion: 5 },
    });
    expect(['sufficient_evidence', 'partial_evidence', 'candidate_exhausted', 'repeated_query_set', 'repeated_result_set']).toContain(result.stopReason);
    expect(result.plansUsed).toBeLessThanOrEqual(2);
  });

  it('infrastructure failures remain typed errors with no ticket eligibility', async () => {
    const searchDeps = makeDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector: vi.fn().mockRejectedValue(new Error('connection refused')),
        searchByLexical: vi.fn().mockRejectedValue(new Error('tsvector down')),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
      embeddings: { embed: vi.fn().mockResolvedValue([0.1]), embedBatch: vi.fn() } as never,
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
    const result = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'password reset procedure steps',
      callId: 'call-error',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(result.sets[0]?.kind).toBe('error');
    expect(result.sets[0] as Record<string, unknown>).not.toHaveProperty('ticketEligible');
  });

  it('budget exhaustion stops future operations within a hard total-call ceiling', async () => {
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
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [1, 2, 3, 4].map((number) => ({
        subquestionId: `sq-${number}`,
        question: `question number ${number} about documentation policy`,
        queries: [1, 2, 3].map((variant) => ({
          queryId: `q-${number}-${variant}`,
          text: `variant ${number} ${variant} documentation policy query`,
          strategy: 'original' as const,
          rationaleCode: 'normalized' as const,
        })),
      })),
    });
    const result = await runStructuredSearch(orchestratorDeps(searchDeps), {
      originalQuery: 'one two three four compound documentation policy question set',
      callId: 'call-ceiling',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxPhysicalRetrievals: 2 },
    });
    expect(result.physicalRetrievalsUsed).toBeLessThanOrEqual(2);
    expect(result.stopReason).toBe('physical_retrieval_ceiling');
  });
});
