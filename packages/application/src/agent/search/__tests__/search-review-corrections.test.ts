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
    chunkUid: `uid-${overrides.documentId}-0`,
    documentUid: `doc-${overrides.documentId}`,
    ...overrides,
  } as RetrievedChunkRow;
}

function baseChunks(overrides?: Record<string, unknown>): SearchDeps['chunks'] {
  return {
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
    ...(overrides ?? {}),
  } as unknown as SearchDeps['chunks'];
}

function makeDeps(chunks: SearchDeps['chunks']): SearchDeps {
  return {
    chunks,
    embeddings: { embed: vi.fn().mockResolvedValue([0.1]), embedBatch: vi.fn() },
  } as unknown as SearchDeps;
}

describe('WP-4 review corrections', () => {
  it('attributes each fused result to the variant that retrieved it', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('alpha')) return [row({ id: 1, documentId: 11, content: 'Alpha only.' })];
        if (query.includes('beta')) return [row({ id: 2, documentId: 22, content: 'Beta only.' })];
        return [];
      }),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'alpha beta combined retrieval check',
          queries: [
            { queryId: 'q-a', text: 'alpha variant query', strategy: 'original', rationaleCode: 'normalized' },
            { queryId: 'q-b', text: 'beta variant query', strategy: 'semantic', rationaleCode: 'remove_chatter' },
          ],
        },
      ],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'alpha beta combined retrieval check',
      callId: 'call-prov',
      requestedLimit: 5,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    const set = result.sets.find((s) => s.subquestionId === 'sq-1');
    expect(set?.kind).toBe('results');
    if (!set || set.kind !== 'results') throw new Error('expected results');
    const byDoc = new Map(set.results.map((item) => [item.documentId, item.executedQueryIds]));
    expect(byDoc.get(11)).toEqual(['q-a']);
    expect(byDoc.get(22)).toEqual(['q-b']);
    const validIds = new Set(set.executedQueries.map((entry) => entry.queryId));
    for (const item of set.results) {
      for (const queryId of item.executedQueryIds) expect(validIds.has(queryId)).toBe(true);
    }
  });

  it('duplicate-only empties are filtered_duplicates and never ticket-eligible', async () => {
    const only = [row({ id: 1, documentId: 1 }), row({ id: 2, documentId: 2 })];
    const chunks = baseChunks({ searchByLexical: vi.fn().mockResolvedValue(only) });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-1',
          question: 'password reset procedure steps guide',
          queries: [{ queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const seen = new Set(['chunk_uid:uid-1-0', 'chunk_uid:uid-2-0']);
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-duponly',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      excludeChunkIdentities: seen,
    });
    expect(result.sets[0]).toMatchObject({ kind: 'no_match', reason: 'filtered_duplicates', ticketEligible: false });
  });

  it('malformed fallback empties are never ticket-eligible', async () => {
    const chunks = baseChunks({ searchByLexical: vi.fn().mockResolvedValue([]) });
    const malformed = async () => ({ intent: 'nonsense', subquestions: 'oops' });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset procedure steps guide for employees',
      callId: 'call-malformed',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: malformed as never,
    });
    expect(result.isFallback).toBe(true);
    expect(result.sets[0]?.kind).toBe('no_match');
    if (result.sets[0]?.kind === 'no_match') expect(result.sets[0].ticketEligible).toBe(false);
  });

  it('the requested limit is a hard per-call ceiling', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('account')) return [row({ id: 11, documentId: 11, content: `Hit ${query}` })];
        if (query.includes('refund')) return [row({ id: 22, documentId: 22, content: `Hit ${query}` })];
        return [row({ id: 99, documentId: 99, content: `Hit ${query}` })];
      }),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-a',
          question: 'account lockout policy duration rules',
          queries: [{ queryId: 'q-a1', text: 'account lockout policy', strategy: 'original', rationaleCode: 'normalized' }],
        },
        {
          subquestionId: 'sq-b',
          question: 'refund deadline policy days rules',
          queries: [{ queryId: 'q-b1', text: 'refund deadline policy', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'account lockout policy duration and refund deadline days',
      callId: 'call-hardlimit',
      requestedLimit: 1,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    const totalResults = result.sets.flatMap((set) => (set.kind === 'results' ? set.results : []));
    expect(totalResults.length).toBeLessThanOrEqual(1);
    expect(result.truncatedBy).toContain('call_result_limit');
    for (const set of result.sets) {
      if (set.kind === 'no_match') expect(set.ticketEligible).toBe(false);
    }
  });

  it('mixed variant failure with empty success becomes a typed error, never eligible no_match', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([]),
    });
    const depsWithFailingEmbed = {
      chunks,
      embeddings: {
        embed: vi.fn().mockImplementation(async (query: string) => {
          if (query.includes('boom')) throw new Error('embedding down');
          return [0.1];
        }),
        embedBatch: vi.fn(),
      },
    } as unknown as SearchDeps;
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [{
        subquestionId: 'sq-1',
        question: 'password reset procedure steps guide',
        queries: [
          { queryId: 'q-1', text: 'boom password reset', strategy: 'original', rationaleCode: 'normalized' },
          { queryId: 'q-2', text: 'password reset procedure', strategy: 'semantic', rationaleCode: 'remove_chatter' },
        ],
      }],
    });
    const result = await runStructuredSearch({ search: depsWithFailingEmbed }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-mixed-fail',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    expect(result.sets[0]?.kind).toBe('error');
    expect(result.sets[0] as Record<string, unknown>).not.toHaveProperty('ticketEligible');
  });

  it('token estimates match serialized model-visible length', async () => {
    const { estimateChunkTokens } = await import('../evidence-packer');
    const { serializeUntrustedChunk } = await import('../../prompt/serialize-untrusted-result');
    const content = 'Evidence content for token accounting.';
    const source = 'docs/guide.md';
    expect(estimateChunkTokens({ content, source })).toBe(
      Math.max(1, Math.ceil(serializeUntrustedChunk({ content, source }).length / 4)),
    );
  });

  it('shared stable chunks resolve to filtered_duplicates, never false eligible no_match', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes('first')) return [row({ id: 1, documentId: 1, chunkUid: 'same', content: 'shared' })];
        return [row({ id: 1, documentId: 1, chunkUid: 'same', content: 'shared' })];
      }),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-a',
          question: 'first topic policy details',
          queries: [{ queryId: 'qa', text: 'first', strategy: 'original', rationaleCode: 'normalized' }],
        },
        {
          subquestionId: 'sq-b',
          question: 'second topic policy details',
          queries: [{ queryId: 'qb', text: 'second', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'first topic and second topic policy details',
      callId: 'call-shared',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    const bySub = new Map(result.sets.map((set) => [set.subquestionId, set]));
    expect(bySub.get('sq-a')?.kind).toBe('results');
    expect(bySub.get('sq-b')).toMatchObject({ kind: 'no_match', reason: 'filtered_duplicates', ticketEligible: false });
  });

  it('a plan that drops preserved tokens falls back to the normalized original', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
    });
    const trace: { toolName: string; callId: string; phase: string; durationMs: number | null }[] = [];
    const leaky = async () => ({
      intent: 'documentation',
      subquestions: [{
        subquestionId: 'sq-1',
        question: 'ERR-4291 retry procedure',
        queries: [{ queryId: 'q-1', text: 'retry procedure', strategy: 'semantic', rationaleCode: 'remove_chatter' }],
      }],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'ERR-4291 retry procedure',
      callId: 'call-preserve',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: leaky as never,
      trace: { write: (event) => { trace.push(event); } },
    });
    expect(result.isFallback).toBe(true);
    expect(result.fallbackReason).toBe('planner_preservation');
    expect(trace.length).toBeGreaterThan(0);
    const first = result.sets[0];
    if (first?.kind === 'results') {
      expect(first.executedQueries[0]?.query).toContain('ERR-4291');
    }
  });

  it('shared chunks retain every associated subquestion and query ID', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1, chunkUid: 'shared-1', content: 'Shared evidence.' })]),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [
        {
          subquestionId: 'sq-a',
          question: 'first topic policy details',
          queries: [{ queryId: 'qa', text: 'first topic', strategy: 'original', rationaleCode: 'normalized' }],
        },
        {
          subquestionId: 'sq-b',
          question: 'second topic policy details',
          queries: [{ queryId: 'qb', text: 'second topic', strategy: 'original', rationaleCode: 'normalized' }],
        },
      ],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'first topic and second topic policy details',
      callId: 'call-prov-map',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
    });
    const entry = result.chunkProvenance.get('chunk_uid:shared-1');
    expect(entry?.subquestionIds).toEqual(expect.arrayContaining(['sq-a', 'sq-b']));
    expect(entry?.queryIds).toEqual(expect.arrayContaining(['qa', 'qb']));
  });

  it('a non-documentation follow-up still reports the executed plan queries', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
    });
    let calls = 0;
    const planner = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          intent: 'documentation',
          subquestions: [{
            subquestionId: 'sq-1',
            question: 'password reset procedure steps guide employee handbook',
            queries: [{ queryId: 'q-exec', text: 'password reset procedure', strategy: 'original', rationaleCode: 'normalized' }],
          }],
        };
      }
      return {
        intent: 'clarification_needed',
        subquestions: [{
          subquestionId: 'sq-99',
          question: 'unrelated follow-up question text here',
          queries: [{ queryId: 'q-never', text: 'unrelated follow-up', strategy: 'original', rationaleCode: 'normalized' }],
        }],
      };
    };
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset procedure steps guide employee handbook',
      callId: 'call-followup-plan',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxResultsPerSubquestion: 5 },
    });
    expect(result.stopReason).toBe('clarification_needed');
    const ids = result.sets.flatMap((set) =>
      set.kind === 'results' ? set.executedQueries.map((entry) => entry.queryId) : [],
    );
    expect(ids).not.toContain('q-never');
  });

  it('a timed-out signal classifies as timeout, not cancellation', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [{
        subquestionId: 'sq-1',
        question: 'password reset procedure steps guide',
        queries: [{ queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' }],
      }],
    });
    const timedOut = new AbortController();
    timedOut.abort(new DOMException('deadline exceeded', 'TimeoutError'));
    const timeoutResult = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-timeout',
      requestedLimit: 3,
      signal: timedOut.signal,
      planner: planner as never,
    });
    expect(timeoutResult.stopReason).toBe('timeout');
    expect(timeoutResult.sets[0]).toMatchObject({ kind: 'error', code: 'timeout' });
    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledResult = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset procedure steps guide',
      callId: 'call-cancelled',
      requestedLimit: 3,
      signal: cancelled.signal,
      planner: planner as never,
    });
    expect(cancelledResult.stopReason).toBe('cancelled');
    expect(cancelledResult.sets[0]).toMatchObject({ kind: 'error', code: 'cancelled' });
  });

  it('aborts every started retrieval when the local deadline expires', async () => {
    const observedSignals: AbortSignal[] = [];
    const waitForAbort = (_value: unknown, options: { signal?: AbortSignal }): Promise<never> => {
      const signal = options.signal;
      if (!signal) throw new Error('expected retrieval signal');
      observedSignals.push(signal);
      return new Promise<never>(() => undefined);
    };
    const chunks = baseChunks({
      searchByVector: vi.fn(waitForAbort),
      searchByLexical: vi.fn(waitForAbort),
    });
    const planner = async () => ({
      intent: 'documentation',
      subquestions: [{
        subquestionId: 'sq-1',
        question: 'password reset documentation procedure',
        queries: [
          { queryId: 'q-1', text: 'password reset', strategy: 'original', rationaleCode: 'normalized' },
          { queryId: 'q-2', text: 'password recovery', strategy: 'semantic', rationaleCode: 'remove_chatter' },
        ],
      }],
    });
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'password reset documentation procedure',
      callId: 'call-local-deadline',
      requestedLimit: 3,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 20,
      planner: planner as never,
    });
    expect(['timeout', 'deadline_exceeded']).toContain(result.stopReason);
    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('a malformed follow-up plan falls back to the normalized original query and is traced', async () => {
    const lexical = vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]);
    const chunks = baseChunks({ searchByLexical: lexical });
    const trace: { toolName: string; callId: string; phase: string; durationMs: number | null }[] = [];
    let calls = 0;
    const planner = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          intent: 'documentation',
          subquestions: [{
            subquestionId: 'sq-1',
            question: 'ERR-4291 retry procedure steps guide handbook',
            queries: [{ queryId: 'q-1', text: 'ERR-4291 retry procedure', strategy: 'original', rationaleCode: 'normalized' }],
          }],
        };
      }
      return {
        intent: 'documentation',
        subquestions: [{
          subquestionId: 'sq-1',
          question: 'ERR-4291 retry procedure steps guide handbook',
          queries: [{ queryId: 'q-2', text: 'retry follow-up details', strategy: 'semantic', rationaleCode: 'coverage_gap' }],
        }],
      };
    };
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'ERR-4291 retry procedure steps guide handbook',
      callId: 'call-leaky-followup',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      trace: { write: (event) => { trace.push(event); } },
    });
    expect(calls).toBe(2);
    expect(result.plansUsed).toBe(2);
    expect(result.isFallback).toBe(true);
    expect(result.fallbackReason).toBe('followup_planner_malformed');
    expect(lexical.mock.calls.some((call) => call[0] === 'ERR-4291 retry procedure steps guide handbook')).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
    expect(result.sets[0]?.kind).toBe('results');
  });

  it('does not reuse an old result set when the same query is reassigned to a different subquestion', async () => {
    const lexical = vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]);
    const chunks = baseChunks({ searchByLexical: lexical });
    let calls = 0;
    const planner = async () => {
      calls += 1;
      const subquestionId = calls === 1 ? 'sq-account' : 'sq-refund';
      return {
        intent: 'documentation',
        subquestions: [{
          subquestionId,
          question: 'Acme policy documentation details',
          queries: [{ queryId: `q-${calls}`, text: 'Acme policy', strategy: 'original', rationaleCode: calls === 1 ? 'normalized' : 'coverage_gap' }],
        }],
      };
    };
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'Acme policy documentation details',
      callId: 'call-reassigned-query',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxResultsPerSubquestion: 3, maxSearchPlans: 2 },
    });
    expect(calls).toBe(2);
    expect(lexical).toHaveBeenCalledTimes(2);
    expect(result.sets.some((set) => set.subquestionId === 'sq-refund')).toBe(true);
  });

  it('physical-ceiling exhaustion still returns a valid non-empty tool payload', async () => {
    const chunks = baseChunks({
      searchByLexical: vi.fn().mockResolvedValue([row({ id: 1, documentId: 1 })]),
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
    const result = await runStructuredSearch({ search: makeDeps(chunks) }, {
      originalQuery: 'one two three four compound documentation policy question set',
      callId: 'call-ceiling-valid',
      requestedLimit: 3,
      signal: new AbortController().signal,
      planner: planner as never,
      budgets: { maxPhysicalRetrievals: 2 },
    });
    expect(result.stopReason).toBe('physical_retrieval_ceiling');
    expect(result.sets.length).toBeGreaterThanOrEqual(1);
    const bySub = new Map(result.sets.map((set) => [set.subquestionId, set]));
    expect(bySub.size).toBe(4);
    expect(bySub.get('sq-1')?.kind).toBe('results');
    for (const subId of ['sq-2', 'sq-3', 'sq-4']) {
      const set = bySub.get(subId);
      expect(set?.kind).toBe('error');
      if (set?.kind === 'error') {
        expect(set.retryable).toBe(false);
        expect(set.userSafeMessage).toContain('budget');
      }
    }
  });
});
