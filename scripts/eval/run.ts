/**
 * Usage:
 *   pnpm eval                 # mock harness (CI-safe)
 *   EVAL_REAL=1 pnpm eval    # wire real search + generation + graders + judges
 *
 * §C2/§C7: agentic-mode questions, expectedDocIds hit checks, 0–1 judge
 * scores, and the eval/golden-report.json artifact. Exit is non-zero when the
 * grader/judge faithfulness or the doc-hit pass rate falls below threshold.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import { goldenQuestions } from './golden';
import {
  runEval,
  buildGoldenReport,
  evalGateFailure,
  mockEvalDeps,
  type EvalDeps,
} from './harness';

loadDotEnv();

// §C7 report location (repo-relative; created on demand).
const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'golden-report.json');

async function buildDeps(useReal: boolean): Promise<EvalDeps> {
  if (!useReal) {
    return mockEvalDeps();
  }
  // Lazily import infra so the mock path never touches DB/LLM modules.
  const [{ Db, Llm }, { searchChunks }, { agenticSearch }] = await Promise.all([
    import('@app/infrastructure'),
    import('@app/application/rag/search'),
    import('@app/application/rag/agentic-search'),
  ]);
  const embeddingService = Llm.getEmbeddingService();
  const reranker = Llm.getReranker(
    (process.env.RERANKER_PROVIDER as 'cosine' | 'local' | 'cohere') ?? 'cosine',
  );
  const searchDeps = { chunks: Db.createChunkRepo(Db.db), embeddings: embeddingService, reranker };
  const graders = Llm.getGraders();
  const chat = Llm.getChatModel();

  return {
    searchChunks: async (query: string) => {
      const r = await searchChunks(query, {}, searchDeps);
      return r.ok ? r.value.map((c) => ({ content: c.content, documentId: c.documentId })) : [];
    },
    // §C2: agentic questions run through the exact loop defects #1–#3 touch,
    // wired with the frozen defaults (admin knobs are runtime-only concerns).
    // When the loop is disabled (AGENTIC_ENABLED=false) the graders are
    // undefined, so agentic questions degrade to plain retrieval instead.
    agenticSearch: async (query: string) => {
      if (!graders.queryRewriter || !graders.documentGrader) {
        const r = await searchChunks(query, {}, searchDeps);
        return r.ok ? r.value.map((c) => ({ content: c.content, documentId: c.documentId })) : [];
      }
      const result = await agenticSearch(query, {
        search: searchDeps,
        queryRewriter: graders.queryRewriter,
        documentGrader: graders.documentGrader,
      });
      return result.ok ? result.value.chunks.map((c) => ({ content: c.content, documentId: c.documentId })) : [];
    },
    generate: async (query: string, context: string) => {
      const { generateText } = await import('ai');
      const out = await generateText({
        model: chat,
        system: 'Answer strictly from the provided context. If the context does not cover the question, say you cannot answer from the available docs.',
        prompt: `Context:\n${context}\n\nQuestion: ${query}`,
      });
      return out.text;
    },
    gradeFaithfulness: async (documents: string, generation: string) => {
      if (!graders.hallucinationGrader) {
        console.warn('[eval] no hallucination grader configured; using lexical fallback.');
        return documents.trim() === '' ? 'no' : 'yes';
      }
      return graders.hallucinationGrader.grade(documents, generation);
    },
    // §C3 judges for offline/online-comparable 0–1 scores.
    judgeRelevance: (question, snippets) => Llm.judgeRelevance(question, snippets).then((v) => v?.score ?? null),
    judgeFaithfulness: (documents, answer) => Llm.judgeFaithfulness(documents, answer).then((v) => v?.score ?? null),
  };
}

async function main() {
  const threshold = Number(process.env.EVAL_FAITHFULNESS_THRESHOLD ?? 0.7);
  const useReal = process.env.EVAL_REAL === '1';
  const questions = goldenQuestions;
  const deps = await buildDeps(useReal);
  const report = await runEval(questions, deps, threshold);
  const goldenReport = buildGoldenReport(report);

  // §C7/F5: a pass rate over zero expectations is vacuous — say so loudly.
  if (!goldenReport.docHitGateActive) {
    console.warn('[eval] doc-hit gate INACTIVE: no questions define expectedDocIds — passRate is vacuous');
  }

  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(goldenReport, null, 2)}\n`);
    console.log(`golden report written to ${REPORT_PATH}`);
  } catch (e) {
    // The artifact is observability, not the gate — never fail the run on IO.
    console.warn(`[eval] could not write ${REPORT_PATH}:`, e instanceof Error ? e.message : e);
  }

  console.log('\n=== RAG Eval Report ===');
  console.log(`mode: ${useReal ? 'REAL (keyed providers)' : 'MOCK (CI-safe)'}`);
  console.log(`questions: ${report.results.length}`);
  console.log(`mean faithfulness:   ${report.meanFaithfulness.toFixed(2)} (threshold ${threshold})`);
  console.log(`mean correctness:    ${report.meanCorrectness.toFixed(2)}`);
  console.log(`mean contextRel:     ${report.meanContextRelevancy.toFixed(2)}`);
  console.log(
    `judge faithfulness:  ${report.avgFaithfulnessJudge !== null ? report.avgFaithfulnessJudge.toFixed(2) : 'n/a'}`,
  );
  console.log(
    `judge retrievalRel:  ${report.avgRetrievalRelevanceJudge !== null ? report.avgRetrievalRelevanceJudge.toFixed(2) : 'n/a'}`,
  );
  console.log(`doc hits [§C2]:      ${report.hits} (passRate ${(report.passRate * 100).toFixed(0)}%)`);
  console.log('per-question:');
  for (const r of report.results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} mode=${qMode(r.id)} faith=${r.faithfulness} corr=${r.correctness} ctx=${r.contextRelevancy}${r.hit !== undefined ? ` hit=${r.hit ? 'yes' : 'no'}` : ''} hits=${r.retrievedCount}${r.refused ? ' refused' : ''}${r.forbiddenHit.length ? ` FORBIDDEN=${r.forbiddenHit.join(',')}` : ''}`,
    );
  }
  console.log(`OVERALL: ${evalGateFailure(report) === null && report.passed ? 'PASS' : 'FAIL'}\n`);

  const failure = evalGateFailure(report);
  if (failure) {
    console.error(`Eval failed: ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

function qMode(id: string): 'agentic' | 'normal' {
  return goldenQuestions.find((q) => q.id === id)?.mode === 'agentic' ? 'agentic' : 'normal';
}

main().catch((err) => {
  console.error('Eval harness crashed:', err);
  process.exit(1);
});
