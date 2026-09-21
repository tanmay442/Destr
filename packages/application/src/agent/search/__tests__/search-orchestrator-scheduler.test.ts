import { describe, expect, it, vi } from 'vitest';
import { runStructuredSearch } from '../search-orchestrator';
import { searchChunks } from '../../../rag/search/search-chunks';
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

function chunkDeps(overrides?: Partial<SearchDeps>): SearchDeps {
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

describe('searchChunks precomputedEmbedding (WP-9)', () => {
  it('uses a valid precomputed embedding and skips embed()', async () => {
    const searchByVector = vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]);
    const embed = vi.fn().mockResolvedValue([9.9]);
    const deps = chunkDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector,
        searchByLexical: vi.fn().mockResolvedValue([]),
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
      embeddings: { embed, embedBatch: vi.fn() } as never,
    });
    const result = await searchChunks('password reset', { hybridEnabled: false, precomputedEmbedding: [0.4, 0.5] }, deps);
    expect(result.ok).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    expect(searchByVector).toHaveBeenCalledTimes(1);
    expect(searchByVector.mock.calls[0]?.[0]).toEqual([0.4, 0.5]);
  });

  it('falls back to embed() when precomputed is empty', async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const deps = chunkDeps({ embeddings: { embed, embedBatch: vi.fn() } as never });
    const result = await searchChunks('password reset', { hybridEnabled: false, precomputedEmbedding: [] }, deps);
    expect(result.ok).toBe(true);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('falls back to embed() when precomputed contains non-finite values', async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const deps = chunkDeps({ embeddings: { embed, embedBatch: vi.fn() } as never });
    const nanResult = await searchChunks('password reset', { hybridEnabled: false, precomputedEmbedding: [0.1, Number.NaN] }, deps);
    expect(nanResult.ok).toBe(true);
    const infResult = await searchChunks('password reset', { hybridEnabled: false, precomputedEmbedding: [0.1, Number.POSITIVE_INFINITY] }, deps);
    expect(infResult.ok).toBe(true);
    expect(embed).toHaveBeenCalledTimes(2);
  });
});

describe('search orchestrator retrieval scheduler (WP-9)', () => {
  it('coalesces duplicate variants into one searchChunks call with one embedding batch', async () => {
    const searchByVector = vi.fn().mockResolvedValue([]);
    const searchByLexical = vi.fn().mockImplementation(async (query: string) => [row({ id: 1, documentId: 1, content: `Result for ${query}` })]);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const embedBatch = vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.7, 0.8]));
    const searchDeps = chunkDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector,
        searchByLexical,
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
      embeddings: { embed, embedBatch } as never,
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
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset',
      callId: 'call-sched-dedup',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    // Identical normalized variants share one backend searchChunks execution.
    expect(searchByVector).toHaveBeenCalledTimes(1);
    expect(searchByLexical).toHaveBeenCalledTimes(1);
    // Scheduler batches the single unique text into one embedding batch; the
    // single-item embed() path is never used for retrieval.
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0]?.[0]).toHaveLength(1);
    expect(embed).not.toHaveBeenCalled();
    expect(result.sets[0]?.kind).toBe('results');
  });

  it('batches embeddings once per unique text across distinct variants', async () => {
    const searchByVector = vi.fn().mockResolvedValue([]);
    const searchByLexical = vi.fn().mockImplementation(async (query: string) => [row({ id: query.length, documentId: query.length, content: `Hit ${query}` })]);
    const embed = vi.fn().mockResolvedValue([0.1]);
    const embedBatch = vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.2, 0.3]));
    const searchDeps = chunkDeps({
      chunks: {
        insertMany: vi.fn(),
        deleteByDocumentId: vi.fn(),
        searchByVector,
        searchByLexical,
        getByIds: vi.fn().mockResolvedValue([]),
        getByDocAndRange: vi.fn().mockResolvedValue([]),
        getByDocAndRanges: vi.fn().mockResolvedValue(new Map()),
        countForDocuments: vi.fn(),
        countForAll: vi.fn(),
        countForDocument: vi.fn(),
        recountAll: vi.fn(),
      } as never,
      embeddings: { embed, embedBatch } as never,
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure for employees guide',
          queries: [
            { queryId: 'q-1', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-2', text: 'password reset steps employees', strategy: 'semantic', rationaleCode: 'remove_chatter' },
          ],
        },
      ],
    });
    await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure for employees guide',
      callId: 'call-sched-batch',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    // Two distinct variants -> one embedding batch covering both unique texts.
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(embed).not.toHaveBeenCalled();
    // One hybrid searchChunks call per variant (coalesced pair of items).
    expect(searchByVector).toHaveBeenCalledTimes(2);
    expect(searchByLexical).toHaveBeenCalledTimes(2);
  });

  it('honors scheduler precomputed embeddings even when single embed() would fail', async () => {
    const embed = vi.fn().mockRejectedValue(new Error('single embed must not run'));
    const embedBatch = vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.6]));
    const searchDeps = chunkDeps({
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
      embeddings: { embed, embedBatch } as never,
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
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-sched-precomputed',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(result.sets[0]?.kind).toBe('results');
  });

  it('maps budget omission to the physical retrieval ceiling', async () => {
    const embedBatch = vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
    const searchDeps = chunkDeps({
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
      embeddings: { embed: vi.fn().mockResolvedValue([0.1]), embedBatch } as never,
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
    const result = await runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'one two three four compound documentation policy question set',
      callId: 'call-sched-ceiling',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxPhysicalRetrievals: 2 },
    });
    expect(result.physicalRetrievalsUsed).toBeLessThanOrEqual(2);
    expect(result.stopReason).toBe('physical_retrieval_ceiling');
  });

  it('cancels scheduled retrieval without unhandled rejections', async () => {
    let active = 0;
    let maxActive = 0;
    const searchDeps = chunkDeps({
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
      embeddings: {
        embed: vi.fn().mockResolvedValue([0.1]),
        embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
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
    const promise = runStructuredSearch({ search: searchDeps }, {
      originalQuery: 'concurrent query one two three',
      callId: 'call-sched-cancel',
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

  it('preserves exact stashed failure codes instead of the scheduler transport code', async () => {
    // Degraded embeddings (null) force searchChunks back onto single embed(),
    // whose failure must surface as embedding_unavailable — not the scheduler
    // transport code retrieval_unavailable.
    const embed = vi.fn().mockRejectedValue(new Error('embedding backend down'));
    const embedBatch = vi.fn().mockResolvedValue([null]);
    const searchDeps = chunkDeps({
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
      embeddings: { embed, embedBatch } as never,
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
      callId: 'call-sched-codes',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(result.sets[0]?.kind).toBe('error');
    if (result.sets[0]?.kind !== 'error') throw new Error('expected error set');
    expect(result.sets[0].code).toBe('embedding_unavailable');
  });
});
