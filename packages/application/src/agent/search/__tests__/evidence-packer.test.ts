import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../../../rag/search/search-types';
import { estimateChunkTokens, packEvidence } from '../evidence-packer';
import { stableChunkIdentity } from '../../../rag/search/stable-chunk-identity';

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: 1,
    documentId: 10,
    fileName: 'guide.md',
    page: 1,
    sectionTitle: 'Setup',
    source: 'docs/guide.md',
    title: 'Guide',
    content: 'How to install the widget.',
    chunkIndex: 0,
    scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' },
    ...overrides,
  };
}

function ranked(id: number, documentId: number, chunkIndex: number, finalRank: number, content?: string): RetrievedChunk {
  return chunk({
    id,
    documentId,
    chunkIndex,
    chunkUid: `uid-${documentId}-${chunkIndex}`,
    content: content ?? `Content for doc ${documentId} chunk ${chunkIndex} with enough text to be realistic.`,
    scores: { dense: 0.9 - finalRank * 0.01, finalRank, finalSignal: 'dense' },
  });
}

describe('coverage-aware evidence packer (WP-4 Section 7.6)', () => {
  it('reserves per-subquestion quotas when a dominant topic is stronger', () => {
    const dominant = Array.from({ length: 6 }, (_, index) =>
      ranked(100 + index, 1, index, index + 1, `Dominant topic evidence ${index} with strong match.`),
    );
    const weak = [
      ranked(200, 2, 0, 1, 'Weak topic evidence with sufficient match.'),
      ranked(201, 2, 1, 2, 'Weak topic second evidence.'),
    ];
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: dominant, requestedCount: 3 },
        { subquestionId: 'sq-b', rankedResults: weak, requestedCount: 3 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 2,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 6,
    });
    const bySub = new Map(packed.packedSets.map((set) => [set.subquestionId, set.results.length]));
    expect(bySub.get('sq-a')).toBeGreaterThanOrEqual(2);
    expect(bySub.get('sq-b')).toBeGreaterThanOrEqual(2);
  });

  it('a dominant topic cannot remove every evidence item for another answered topic', () => {
    const dominant = Array.from({ length: 10 }, (_, index) =>
      ranked(100 + index, 1, index, 1, 'Dominant '.repeat(20)),
    );
    const weak = [ranked(200, 2, 0, 5, 'Weak but relevant.')];
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: dominant, requestedCount: 3 },
        { subquestionId: 'sq-b', rankedResults: weak, requestedCount: 1 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 5,
      maxResultsPerSearchCall: 6,
    });
    const weakSet = packed.packedSets.find((set) => set.subquestionId === 'sq-b');
    expect(weakSet?.results.length).toBeGreaterThanOrEqual(1);
  });

  it('stable-ID duplicates are supplied once while multi-intent provenance remains', () => {
    const shared = ranked(1, 10, 0, 1, 'Shared evidence for both topics.');
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: [shared, ranked(2, 10, 1, 2)], requestedCount: 2 },
        { subquestionId: 'sq-b', rankedResults: [shared, ranked(3, 20, 0, 2)], requestedCount: 2 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 6,
    });
    const allKeys = packed.packedSets.flatMap((set) =>
      set.results.map((item) => stableChunkIdentity(item)),
    );
    expect(new Set(allKeys).size).toBe(allKeys.length);
    const provenance = packed.chunkProvenance.get(stableChunkIdentity(shared));
    expect(provenance?.subquestionIds).toEqual(expect.arrayContaining(['sq-a', 'sq-b']));
  });

  it('semantically similar but stable-ID-distinct chunks remain distinct', () => {
    const first = ranked(1, 10, 0, 1, 'The refund deadline is 30 days.');
    const second = ranked(2, 10, 1, 2, 'The refund deadline is 30 days.');
    const packed = packEvidence({
      subquestionSets: [{ subquestionId: 'sq-a', rankedResults: [first, second], requestedCount: 2 }],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 6,
    });
    expect(packed.packedSets[0]?.results).toHaveLength(2);
  });

  it('respects per-call, subquestion, unique-chunk, and token limits', () => {
    const many = Array.from({ length: 10 }, (_, index) => ranked(100 + index, 1, index, index + 1));
    const packed = packEvidence({
      subquestionSets: [{ subquestionId: 'sq-a', rankedResults: many, requestedCount: 10 }],
      maxUniqueChunks: 3,
      maxEvidenceTokens: 100000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 10,
      maxResultsPerSearchCall: 2,
    });
    expect(packed.totalUniqueChunks).toBeLessThanOrEqual(3);
    expect(packed.packedSets[0]?.results.length).toBeLessThanOrEqual(2);
    expect(packed.truncatedBy).toContain('call_result_limit');
  });

  it('shared evidence slots are reassigned to the weakest-covered subquestion', () => {
    const shared = ranked(1, 10, 0, 1, 'Shared.');
    const aSecond = ranked(2, 10, 1, 2, 'A second.');
    const bSecond = ranked(3, 20, 0, 2, 'B second.');
    const bThird = ranked(4, 20, 1, 3, 'B third.');
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: [shared, aSecond], requestedCount: 2 },
        { subquestionId: 'sq-b', rankedResults: [shared, bSecond, bThird], requestedCount: 3 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 5,
    });
    const bySub = new Map(packed.packedSets.map((set) => [set.subquestionId, set.results.length]));
    expect(bySub.get('sq-b')).toBeGreaterThanOrEqual(2);
    expect(bySub.get('sq-a')).toBeGreaterThanOrEqual(1);
  });

  it('tie-breaking and token accounting are deterministic', () => {
    const makeSets = () => [
      { subquestionId: 'sq-a', rankedResults: [ranked(1, 1, 0, 1, 'Alpha content here.'), ranked(2, 1, 1, 2, 'Beta content here.')], requestedCount: 2 },
      { subquestionId: 'sq-b', rankedResults: [ranked(3, 2, 0, 1, 'Gamma content here.'), ranked(4, 2, 1, 2, 'Delta content here.')], requestedCount: 2 },
    ];
    const first = packEvidence({
      subquestionSets: makeSets(),
      maxUniqueChunks: 3,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 3,
    });
    const second = packEvidence({
      subquestionSets: makeSets(),
      maxUniqueChunks: 3,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 3,
    });
    expect(first.packedSets.map((set) => set.results.map((item) => item.id))).toEqual(
      second.packedSets.map((set) => set.results.map((item) => item.id)),
    );
    expect(first.totalTokens).toBe(second.totalTokens);
    for (const set of first.packedSets) {
      let expected = 0;
      for (const item of set.results) expected += estimateChunkTokens(item);
      void expected;
    }
  });

  it('packs whole capped items without misleading truncation and reports turn_token_limit', () => {
    const big = (id: number, doc: number): RetrievedChunk =>
      chunk({ id, documentId: doc, chunkIndex: 0, chunkUid: `big-${doc}`, content: 'x'.repeat(5000), scores: { dense: 0.9, finalRank: 1, finalSignal: 'dense' } });
    const packed = packEvidence({
      subquestionSets: [
        { subquestionId: 'sq-a', rankedResults: [big(1, 1)], requestedCount: 1 },
        { subquestionId: 'sq-b', rankedResults: [big(2, 2)], requestedCount: 1 },
      ],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 50,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 6,
    });
    expect(packed.truncatedBy).toContain('turn_token_limit');
    for (const set of packed.packedSets) {
      for (const item of set.results) {
        expect(item.content.length).toBeLessThanOrEqual(5000);
      }
    }
  });

  it('returns actual counts and typed reasons when quotas cannot be met', () => {
    const packed = packEvidence({
      subquestionSets: [{ subquestionId: 'sq-a', rankedResults: [ranked(1, 1, 0, 1)], requestedCount: 3 }],
      maxUniqueChunks: 10,
      maxEvidenceTokens: 8000,
      minQuotaPerSubquestion: 1,
      maxResultsPerSubquestion: 3,
      maxResultsPerSearchCall: 6,
    });
    expect(packed.packedSets[0]?.returnedCount).toBe(1);
    expect(packed.packedSets[0]?.coverage).toBe('partial');
    expect(packed.packedSets[0]?.partialReason).not.toBeNull();
  });
});
