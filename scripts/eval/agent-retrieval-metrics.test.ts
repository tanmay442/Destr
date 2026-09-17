import { describe, expect, it } from 'vitest';
import { goldenQuestions } from './golden';
import { mockEvalDeps } from './harness';
import { searchSyntheticMockCorpus, SYNTHETIC_MOCK_CORPUS_VERSION } from './mock-corpus';
import { AGENT_GOLDEN_CORPUS } from './agent-golden-corpus';
import { DEFAULT_TOOL_CAPABILITIES } from '../../packages/application/src/agent/model-tool-capabilities';
import { createScriptedBackend } from '../../packages/application/src/agent/scripted-model';
import { buildCasePlan, executeCase } from './agent-trajectory';

function recallAt(ranked: readonly number[], expected: ReadonlySet<number>, k: number): number {
  if (expected.size === 0) return 1;
  const hits = ranked.slice(0, k).filter((id) => expected.has(id)).length;
  return Math.min(1, hits / Math.min(k, expected.size));
}

function reciprocalRank(ranked: readonly number[], expected: ReadonlySet<number>): number {
  const index = ranked.findIndex((id) => expected.has(id));
  return index < 0 || index >= 10 ? 0 : 1 / (index + 1);
}

describe('agent retrieval golden metrics on the fixed synthetic snapshot', () => {
  it('reports recall, MRR, and no-match classification across normal/planner/diagnostic modes', async () => {
    const deps = mockEvalDeps();
    const answerable = goldenQuestions.filter((q) => (q.expectedMockDocIds ?? []).length > 0);
    const noMatch = goldenQuestions.filter((q) => (q.expectedMockDocIds ?? []).length === 0);
    expect(answerable.length).toBeGreaterThan(0);
    expect(SYNTHETIC_MOCK_CORPUS_VERSION).toBe('synthetic-mock-corpus.v2');
    for (const mode of ['normal', 'planner', 'diagnostic'] as const) {
      const recalls: number[] = [];
      const rrs: number[] = [];
      let noMatchCorrect = 0;
      for (const q of answerable) {
        const retrieved = mode === 'normal'
          ? await deps.searchChunks(q.question)
          : await deps.agenticSearch?.(q.question) ?? [];
        const ids = retrieved.map((r) => r.documentId ?? -1);
        const expected = new Set(q.expectedMockDocIds ?? []);
        recalls.push(recallAt(ids, expected, 5));
        rrs.push(reciprocalRank(ids, expected));
      }
      for (const q of noMatch) {
        const retrieved = await deps.searchChunks(q.question);
        if (retrieved.length === 0 || q.refusalExpected === true) noMatchCorrect += 1;
      }
      const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
      console.log(`[retrieval-metrics] mode=${mode} snapshot=${SYNTHETIC_MOCK_CORPUS_VERSION} recall@5=${mean(recalls).toFixed(3)} mrr@10=${mean(rrs).toFixed(3)} noMatchRecall=${(noMatchCorrect / Math.max(1, noMatch.length)).toFixed(3)}`);
      expect(mean(recalls)).toBeGreaterThan(0);
    }
  });

  it('measures per-subquestion recall, overlap rate, backfill, and evidence packing through the production loop', async () => {
    const overlap = AGENT_GOLDEN_CORPUS.filter((c) => c.primaryCategory === 'overlap_two_calls').slice(0, 4);
    const backfill = AGENT_GOLDEN_CORPUS.filter((c) => c.primaryCategory === 'backfill').slice(0, 4);
    const twoSubs = AGENT_GOLDEN_CORPUS.filter((c) => c.primaryCategory === 'two_subquestions').slice(0, 4);
    expect(overlap.length + backfill.length + twoSubs.length).toBeGreaterThan(0);
    let overlapCases = 0;
    let backfilledCases = 0;
    let subquestionCovered = 0;
    let subquestionTotal = 0;
    let uniqueEvidence = 0;
    let evidenceTokens = 0;
    let caseIndex = 0;
    for (const goldenCase of [...overlap, ...backfill, ...twoSubs]) {
      caseIndex += 1;
      const plan = buildCasePlan(goldenCase, caseIndex);
      const report = await executeCase({
        goldenCase,
        caseIndex,
        backend: createScriptedBackend(plan.steps),
        capabilities: DEFAULT_TOOL_CAPABILITIES,
        runPrefix: 'retrieval-metrics',
      });
      expect(report.passed).toBe(true);
      const uniqueChunks = new Set(report.chunkUids);
      uniqueEvidence += uniqueChunks.size;
      evidenceTokens += report.evidenceTokens;
      for (const sub of goldenCase.expectedSubquestions ?? []) {
        subquestionTotal += 1;
        const wanted = new Set(sub.chunkUids ?? []);
        const hit = wanted.size === 0 || [...wanted].some((uid) => uniqueChunks.has(uid));
        if (hit) subquestionCovered += 1;
      }
      if (goldenCase.primaryCategory === 'overlap_two_calls' && report.chunkUids.length > 0) overlapCases += 1;
      if (goldenCase.primaryCategory === 'backfill' && (report.backfillCount > 0 || report.chunkUids.length > 0)) backfilledCases += 1;
    }
    console.log(`[retrieval-metrics] subquestionCoverage=${subquestionCovered}/${subquestionTotal} overlapCases=${overlapCases} backfilledCases=${backfilledCases} uniqueEvidence=${uniqueEvidence} evidenceTokens=${evidenceTokens}`);
    expect(subquestionTotal).toBeGreaterThan(0);
    expect(subquestionCovered / subquestionTotal).toBeGreaterThanOrEqual(0.5);
    expect(uniqueEvidence).toBeGreaterThan(0);
    expect(evidenceTokens).toBeGreaterThan(0);
    expect(searchSyntheticMockCorpus).toBeDefined();
  });
});
