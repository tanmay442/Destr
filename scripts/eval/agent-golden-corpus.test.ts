import { describe, expect, it } from 'vitest';
import {
  AGENT_GOLDEN_CATEGORY_KEYS,
  AGENT_GOLDEN_CATEGORY_MINIMUMS,
  AGENT_GOLDEN_CORPUS,
  AGENT_GOLDEN_CORPUS_VERSION,
  countByCategory,
  type AgentGoldenCase,
  type AgentGoldenCategoryKey,
} from './agent-golden-corpus';
import { syntheticMockCorpusManifest } from './mock-corpus';

const KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RETRIEVAL_PRIMARIES: readonly AgentGoldenCategoryKey[] = [
  'doc_search',
  'overlap_two_calls',
  'backfill',
  'two_subquestions',
  'dominant_topic',
  'similar_chunks',
  'packing_limits',
];

function caseTexts(goldenCase: AgentGoldenCase): string[] {
  return [
    goldenCase.userText,
    ...(goldenCase.history ?? []).map((turn) => turn.text),
    ...(goldenCase.notes === undefined ? [] : [goldenCase.notes]),
  ];
}

describe('agent golden corpus', () => {
  it('pins the stable corpus version', () => {
    expect(AGENT_GOLDEN_CORPUS_VERSION).toBe('agent-golden-corpus.v1');
  });

  it('meets all 16 Layer D category minimums independently', () => {
    const counts = countByCategory(AGENT_GOLDEN_CORPUS);
    for (const key of AGENT_GOLDEN_CATEGORY_KEYS) {
      const minimum = AGENT_GOLDEN_CATEGORY_MINIMUMS[key];
      expect(counts[key] ?? 0, `category ${key}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('holds a large multi-category corpus', () => {
    expect(AGENT_GOLDEN_CORPUS.length).toBeGreaterThanOrEqual(250);
    const multiTagged = AGENT_GOLDEN_CORPUS.filter((goldenCase) => goldenCase.categories.length > 1);
    expect(multiTagged.length).toBeGreaterThan(0);
  });

  it('uses stable unique kebab-case ids', () => {
    const ids = AGENT_GOLDEN_CORPUS.map((goldenCase) => goldenCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, id).toMatch(KEBAB_PATTERN);
    }
  });

  it('gives every case tools, result class, side effect, and grounding', () => {
    const resultClasses = new Set(['results', 'no_match', 'error', 'clarification', 'no_tool']);
    const sideEffects = new Set(['none', 'ticket_created', 'ticket_denied']);
    const groundings = new Set(['verified', 'rejected', 'unverified', 'not_required']);
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      expect(Array.isArray(goldenCase.expectedTools), goldenCase.id).toBe(true);
      expect(Array.isArray(goldenCase.forbiddenTools), goldenCase.id).toBe(true);
      expect(resultClasses.has(goldenCase.resultClass), goldenCase.id).toBe(true);
      expect(sideEffects.has(goldenCase.sideEffect), goldenCase.id).toBe(true);
      expect(groundings.has(goldenCase.grounding), goldenCase.id).toBe(true);
      expect(goldenCase.categories.length, goldenCase.id).toBeGreaterThan(0);
      expect(goldenCase.categories, goldenCase.id).toContain(goldenCase.primaryCategory);
      const overlap = goldenCase.expectedTools.filter((tool) =>
        goldenCase.forbiddenTools.includes(tool),
      );
      expect(overlap, goldenCase.id).toEqual([]);
    }
  });

  it('keeps the retrieval doc-hit gate non-vacuous', () => {
    const retrievalCases = AGENT_GOLDEN_CORPUS.filter((goldenCase) =>
      RETRIEVAL_PRIMARIES.includes(goldenCase.primaryCategory),
    );
    expect(retrievalCases.length).toBeGreaterThan(0);
    for (const goldenCase of retrievalCases) {
      const docCount = goldenCase.expectedDocIds?.length ?? 0;
      const uidCount = goldenCase.documentUids?.length ?? 0;
      expect(docCount + uidCount, goldenCase.id).toBeGreaterThan(0);
    }
    const answered = AGENT_GOLDEN_CORPUS.filter((goldenCase) => goldenCase.resultClass === 'results');
    expect(answered.length).toBeGreaterThan(0);
    for (const goldenCase of answered) {
      const docCount = goldenCase.expectedDocIds?.length ?? 0;
      const uidCount = goldenCase.documentUids?.length ?? 0;
      expect(docCount + uidCount, goldenCase.id).toBeGreaterThan(0);
    }
  });

  it('references only known synthetic documents and chunks', () => {
    const knownDocIds = new Set(syntheticMockCorpusManifest.records.map((record) => record.documentId));
    const knownDocUids = new Set(syntheticMockCorpusManifest.records.map((record) => record.documentUid));
    const chunkToDoc = new Map(
      syntheticMockCorpusManifest.records.map((record) => [record.chunkUid, record.documentId] as const),
    );
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      for (const docId of goldenCase.expectedDocIds ?? []) {
        expect(knownDocIds.has(docId), `${goldenCase.id} doc ${docId}`).toBe(true);
      }
      for (const documentUid of goldenCase.documentUids ?? []) {
        expect(knownDocUids.has(documentUid), `${goldenCase.id} uid ${documentUid}`).toBe(true);
      }
      for (const chunkUid of goldenCase.expectedChunkUids ?? []) {
        expect(chunkToDoc.has(chunkUid), `${goldenCase.id} chunk ${chunkUid}`).toBe(true);
      }
    }
  });

  it('contains no secrets or production data and keeps text short', () => {
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      expect(goldenCase.userText.length, goldenCase.id).toBeGreaterThanOrEqual(8);
      expect(goldenCase.userText.length, goldenCase.id).toBeLessThanOrEqual(500);
      for (const text of caseTexts(goldenCase)) {
        expect(text, goldenCase.id).not.toContain('@');
        expect(text, goldenCase.id).not.toContain('sk-');
      }
      for (const turn of goldenCase.history ?? []) {
        expect(turn.text.length, goldenCase.id).toBeGreaterThanOrEqual(2);
        expect(turn.text.length, goldenCase.id).toBeLessThanOrEqual(500);
      }
    }
  });

  it('bounds multi-turn history and requires it for reference cases', () => {
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      expect(goldenCase.history?.length ?? 0, goldenCase.id).toBeLessThanOrEqual(4);
    }
    const referenceCases = AGENT_GOLDEN_CORPUS.filter((goldenCase) =>
      goldenCase.categories.includes('multiturn_reference'),
    );
    expect(referenceCases.length).toBeGreaterThanOrEqual(20);
    for (const goldenCase of referenceCases) {
      expect(goldenCase.history?.length ?? 0, goldenCase.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('requires subquestions, counts, and packing limits where applicable', () => {
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      if (
        goldenCase.categories.includes('two_subquestions')
        || goldenCase.categories.includes('dominant_topic')
      ) {
        expect(goldenCase.expectedSubquestions?.length ?? 0, goldenCase.id).toBeGreaterThanOrEqual(2);
      }
      if (goldenCase.categories.includes('packing_limits')) {
        expect(goldenCase.packingLimits, goldenCase.id).toBeDefined();
      }
      if (
        goldenCase.categories.includes('overlap_two_calls')
        || goldenCase.categories.includes('backfill')
      ) {
        expect(goldenCase.requestedResults, goldenCase.id).toBeDefined();
        expect(goldenCase.newResults, goldenCase.id).toBeDefined();
        expect(goldenCase.newResults ?? 0, goldenCase.id).toBeLessThanOrEqual(
          goldenCase.requestedResults ?? 0,
        );
      }
      if (goldenCase.categories.includes('similar_chunks')) {
        expect(goldenCase.expectedChunkUids?.length ?? 0, goldenCase.id).toBeGreaterThanOrEqual(2);
      }
      if (goldenCase.requestedResults !== undefined && goldenCase.newResults !== undefined) {
        expect(goldenCase.newResults, goldenCase.id).toBeLessThanOrEqual(goldenCase.requestedResults);
      }
    }
  });

  it('counts every category membership in countByCategory', () => {
    const counts = countByCategory(AGENT_GOLDEN_CORPUS);
    const memberships = AGENT_GOLDEN_CORPUS.reduce((total, goldenCase) => total + goldenCase.categories.length, 0);
    const counted = Object.values(counts).reduce((total, count) => total + count, 0);
    expect(counted).toBe(memberships);
    expect(countByCategory([])).toEqual({});
  });
});
