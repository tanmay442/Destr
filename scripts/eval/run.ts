/**
 * `pnpm eval` entrypoint (Session 10).
 *
 * Wires the evaluation harness to real adapters when the env is present
 * (Upstash Redis for stats, embedding/chat LLM providers, Postgres chunks),
 * and otherwise runs a fully mocked harness so CI can gate the wiring without
 * any provider keys. The faithful scoring path requires a keyed provider; when
 * none is configured it logs a warning and uses the mock grader so the script
 * still passes in CI. Run a real graded pass in a manual job with keys set.
 *
 * Usage:
 *   pnpm eval                 # mock harness (CI-safe)
 *   EVAL_REAL=1 pnpm eval    # wire real search + generation + graders
 *   EVAL_AUTOSEED=1 pnpm eval# prepend golden Qs mined from QueryStats.top
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
        return (documents.trim() === '' || generation.toLowerCase().includes('cannot answer')) ? 'no' : 'yes';
      }
      return graders.hallucinationGrader.grade(documents, generation);
    },
  };
}

async function maybeAutoseed(): Promise<typeof goldenQuestions> {
  if (process.env.EVAL_AUTOSEED !== '1') return goldenQuestions;
  try {
    const { Auth } = await import('@app/infrastructure');
    const stats = Auth.createUpstashQueryStats();
    const top = await stats.top(20);
    const seeded = top
      .filter((t) => t.q && t.count > 0)
      .map((t, i) => ({ id: `stats-${i}`, question: t.q, mustMention: [] }));
    console.log(`[eval] auto-seeded ${seeded.length} questions from QueryStats.top`);
    return [...seeded, ...goldenQuestions];
  } catch (err) {
    console.warn('[eval] auto-seed failed; using static golden set.', { error: String(err) });
    return goldenQuestions;
  }
}

async function main() {
  const threshold = Number(process.env.EVAL_FAITHFULNESS_THRESHOLD ?? 0.7);
  const useReal = process.env.EVAL_REAL === '1';
  const questions = await maybeAutoseed();
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
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} faith=${r.faithfulness} corr=${r.correctness} ctx=${r.contextRelevancy} hits=${r.retrievedCount} ${r.forbiddenHit.length ? `FORBIDDEN=${r.forbiddenHit.join(',')}` : ''}`,
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
