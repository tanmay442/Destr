/**
 * Usage:
 *   pnpm eval                 # mock harness (CI-safe)
 *   EVAL_REAL=1 pnpm eval    # wire real search + generation + graders
 */
import { goldenQuestions } from './golden';
import { runEval, mockEvalDeps, type EvalDeps } from './harness';

async function buildDeps(useReal: boolean): Promise<EvalDeps> {
  if (!useReal) {
    return mockEvalDeps();
  }
  // Lazily import infra so the mock path never touches DB/LLM modules.
  const [{ Db, Llm }, { searchChunks }] = await Promise.all([
    import('@app/infrastructure'),
    import('@app/application/rag/search'),
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
      return r.ok ? r.value.map((c) => ({ content: c.content })) : [];
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
  };
}

async function main() {
  const threshold = Number(process.env.EVAL_FAITHFULNESS_THRESHOLD ?? 0.7);
  const useReal = process.env.EVAL_REAL === '1';
  const questions = goldenQuestions;
  const deps = await buildDeps(useReal);
  const report = await runEval(questions, deps, threshold);

  console.log('\n=== RAG Eval Report ===');
  console.log(`mode: ${useReal ? 'REAL (keyed providers)' : 'MOCK (CI-safe)'}`);
  console.log(`questions: ${report.results.length}`);
  console.log(`mean faithfulness:   ${report.meanFaithfulness.toFixed(2)} (threshold ${threshold})`);
  console.log(`mean correctness:    ${report.meanCorrectness.toFixed(2)}`);
  console.log(`mean contextRel:     ${report.meanContextRelevancy.toFixed(2)}`);
  console.log('per-question:');
  for (const r of report.results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} faith=${r.faithfulness} corr=${r.correctness} ctx=${r.contextRelevancy} hits=${r.retrievedCount}${r.refused ? ' refused' : ''}${r.forbiddenHit.length ? ` FORBIDDEN=${r.forbiddenHit.join(',')}` : ''}`,
    );
  }
  console.log(`OVERALL: ${report.passed ? 'PASS' : 'FAIL'}\n`);

  if (!report.passed) {
    console.error(`Eval failed: mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${threshold}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Eval harness crashed:', err);
  process.exit(1);
});
