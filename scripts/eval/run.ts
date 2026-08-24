
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

const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'golden-report.json');

async function buildDeps(useReal: boolean): Promise<EvalDeps> {
  if (!useReal) {
    return mockEvalDeps();
  }
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
  {
    const agenticCount = goldenQuestions.filter((q) => q.mode === 'agentic').length;
    if (agenticCount > 0 && (!graders.queryRewriter || !graders.documentGrader)) {
      console.warn(`[eval] agentic coverage degraded at startup: ${agenticCount} agentic question(s) will run as plain searchChunks (AGENTIC_ENABLED=false or graders unavailable) (EVAL-M4)`);
    }
  }

  return {
    searchChunks: async (query: string) => {
      const r = await searchChunks(query, {}, searchDeps);
      return r.ok ? r.value.map((c) => ({ content: c.content, documentId: c.documentId })) : [];
    },
    agenticSearch: async (query: string) => {
      if (!graders.queryRewriter || !graders.documentGrader) {
        console.warn('[eval] agenticSearch degraded to plain searchChunks: graders unavailable (AGENTIC_ENABLED=false)');
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
        abortSignal: AbortSignal.timeout(30_000),
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
    judgeRelevance: (question, snippets) => Llm.judgeRelevance(question, snippets).then((v) => v?.score ?? null),
    judgeFaithfulness: (documents, answer) => Llm.judgeFaithfulness(documents, answer).then((v) => v?.score ?? null),
  };
}

async function main() {
  const rawThreshold = process.env.EVAL_FAITHFULNESS_THRESHOLD ?? '0.7';
  const threshold = Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`[eval] invalid EVAL_FAITHFULNESS_THRESHOLD="${rawThreshold}" — must be a finite number in (0, 1]; failing closed`);
    process.exit(1);
  }
  const useReal = process.env.EVAL_REAL === '1';
  const questions = goldenQuestions;
  const deps = await buildDeps(useReal);
  const report = await runEval(questions, deps, threshold);
  const goldenReport = buildGoldenReport(report);

  if (!goldenReport.docHitGateActive) {
    console.warn('[eval] doc-hit gate INACTIVE: no questions define expectedDocIds — passRate is vacuous');
  }

  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(goldenReport, null, 2)}\n`);
    console.log(`golden report written to ${REPORT_PATH}`);
  } catch (e) {
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
  const failure = evalGateFailure(report);
  const gateOk = failure === null;
  const overallPass = gateOk && report.passed;
  console.log(`OVERALL: ${overallPass ? 'PASS' : 'FAIL'}\n`);

  if (!overallPass) {
    if (failure) console.error(`Eval failed: ${failure}`);
    else if (!report.passed) console.error(`Eval failed: mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${report.threshold}`);
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
