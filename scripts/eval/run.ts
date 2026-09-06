
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import { goldenQuestions } from './golden';
import {
  runEval,
  buildGoldenReport,
  evalGateFailure,
  fingerprint,
  fingerprintUntrackedFiles,
  mockEvalDeps,
  REAL_SYNTHETIC_INTER_CASE_DELAY_DEFAULT_MS,
  REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS,
  REAL_SYNTHETIC_MAX_ATTEMPTS,
  REAL_SYNTHETIC_RETRY_DELAY_MS,
  sanitizeIdentifier,
  type EvalDeps,
  type EvalMode,
  type EvalProgressEvent,
} from './harness';
import {
  syntheticMockCorpusManifest,
  SYNTHETIC_MOCK_CORPUS_VERSION,
} from './mock-corpus';

loadDotEnv();

const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'golden-report.json');
const TRACE_PATH = join(REPORT_DIR, 'model-interactions.jsonl');
const execFileAsync = promisify(execFile);
const REAL_SYNTHETIC_SYSTEM_PROMPT = 'Answer strictly from the provided context. If the context does not cover the question, say you cannot answer from the available docs.';

let traceModelInteractions = false;
const modelAttemptCounts = new Map<string, number>();

function writeInteractionTrace(record: Readonly<Record<string, unknown>>): void {
  if (!traceModelInteractions) return;
  const serialized = JSON.stringify(record);
  appendFileSync(TRACE_PATH, `${serialized}\n`, 'utf8');
  console.log(`[eval-trace] ${serialized}`);
}

async function gitOutput(args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args]);
    return String(result.stdout).trim() || 'unavailable';
  } catch (error) {
    console.warn(
      `[eval] git ${args.join(' ')} unavailable for provenance:`,
      error instanceof Error ? error.message : error,
    );
    return 'unavailable';
  }
}

async function resolveBaselineCommit(): Promise<string> {
  const deploymentCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (deploymentCommit) return deploymentCommit;

  const localCommit = await gitOutput(['rev-parse', 'HEAD']);
  return localCommit === 'unavailable' ? 'unknown' : localCommit;
}

function configuredModelId(): string | undefined {
  const explicit = process.env.EVAL_MODEL_ID?.trim();
  if (explicit) return explicit;
  const provider = process.env.CHAT_PROVIDER?.trim() ?? 'openai';
  if (provider === 'openai') return process.env.LLM_MODEL?.trim();
  if (provider === 'google') return process.env.GOOGLE_CHAT_MODEL?.trim() ?? 'gemini-2.5-flash';
  if (provider === 'ollama') return process.env.OLLAMA_CHAT_MODEL?.trim() ?? 'gemma4:e2b';
  return undefined;
}

async function buildRealModelDeps(
  candidateModelId: string,
  mode: Exclude<EvalMode, 'mock'>,
) {
  // Import only the LLM boundary.  The real_synthetic branch must never load
  // the database or live retrieval adapters.
  const Llm = await import('@app/infrastructure/llm');
  const adapter = Llm.getChatModelAdapter(candidateModelId);
  const { generateText } = await import('ai');

  const generate = async (query: string, context: string): Promise<string> => {
    const question = goldenQuestions.find((candidate) => candidate.question === query);
    const caseId = question?.id ?? 'unknown-case';
    const attempt = (modelAttemptCounts.get(caseId) ?? 0) + 1;
    modelAttemptCounts.set(caseId, attempt);
    writeInteractionTrace({
      kind: 'model_request',
      recordedAt: new Date().toISOString(),
      caseId,
      attempt,
      model: sanitizeIdentifier(adapter.modelId),
      provider: sanitizeIdentifier(adapter.provider),
      system: REAL_SYNTHETIC_SYSTEM_PROMPT,
      message: { role: 'user', content: `Context:\n${context}\n\nQuestion: ${query}` },
      expected: question === undefined ? null : {
        refusalExpected: question.refusalExpected ?? question.mustMention.length === 0,
        requiredSignals: question.mustMention,
        forbiddenSignals: question.forbidden ?? [],
        expectedDocumentIds: question.expectedMockDocIds ?? [],
        expectedChunkUids: question.expectedMockChunkUids ?? [],
      },
    });
    try {
      const out = await generateText({
        model: adapter.model,
        system: REAL_SYNTHETIC_SYSTEM_PROMPT,
        prompt: `Context:\n${context}\n\nQuestion: ${query}`,
        abortSignal: AbortSignal.timeout(30_000),
      });
      writeInteractionTrace({
        kind: 'model_response',
        recordedAt: new Date().toISOString(),
        caseId,
        attempt,
        message: { role: 'assistant', content: out.text },
      });
      return out.text;
    } catch (error: unknown) {
      const category = classifyEvalFailure(error);
      writeInteractionTrace({
        kind: 'model_error',
        recordedAt: new Date().toISOString(),
        caseId,
        attempt,
        category,
        message: safeFailureMessage(category),
      });
      throw error;
    }
  };

  if (mode === 'real_synthetic') {
    return {
      modelDeps: {
        generate,
        // evaluateOne applies the required-signal seam for this mode. Keep
        // the dependency fail-closed if it is ever invoked directly.
        gradeFaithfulness: async (): Promise<'yes' | 'no'> => 'no',
      },
      aux: {
        queryRewriter: undefined,
        hallucinationGrader: undefined,
      },
      candidateModelId: adapter.modelId,
      candidateProviderId: adapter.provider,
    };
  }

  const aux = Llm.getAuxModels();
  return {
    modelDeps: {
      generate,
      gradeFaithfulness: async (documents: string, generation: string) => {
        if (!aux.hallucinationGrader) {
          console.warn('[eval] no hallucination grader configured; using lexical fallback.');
          return documents.trim() === '' ? 'no' : 'yes';
        }
        return aux.hallucinationGrader.grade(documents, generation);
      },
      judgeRelevance: (question: string, snippets: string[]) => Llm.judgeRelevance(question, snippets).then((v) => v?.score ?? null),
      judgeFaithfulness: (documents: string, answer: string) => Llm.judgeFaithfulness(documents, answer).then((v) => v?.score ?? null),
    },
    aux,
    candidateModelId: adapter.modelId,
    candidateProviderId: adapter.provider,
  };
}

async function buildLiveRealDeps(model: Awaited<ReturnType<typeof buildRealModelDeps>>): Promise<EvalDeps> {
  const [{ db, createChunkRepo }, { searchChunks }, { agenticSearch }] = await Promise.all([
    import('@app/infrastructure/db'),
    import('@app/application/rag/search'),
    import('@app/application/rag/agentic-search'),
  ]);
  const Llm = await import('@app/infrastructure/llm');
  const embeddingService = Llm.getEmbeddingService();
  const reranker = Llm.getReranker(process.env.RERANKER_PROVIDER ?? 'cosine');
  const searchDeps = { chunks: createChunkRepo(db), embeddings: embeddingService, reranker };
  {
    const agenticCount = goldenQuestions.filter((q) => q.mode === 'agentic').length;
    if (agenticCount > 0 && !model.aux.queryRewriter) {
      console.warn(`[eval] agentic coverage degraded at startup: ${agenticCount} agentic question(s) will run as plain searchChunks (AGENTIC_ENABLED=false or aux models unavailable) (EVAL-M4)`);
    }
  }

  return {
    searchChunks: async (query: string) => {
      const r = await searchChunks(query, {}, searchDeps);
      return r.ok
        ? r.value.chunks.map((c) => ({
            content: c.content,
            documentId: c.documentId,
            ...(c.documentUid ? { documentUid: c.documentUid } : {}),
            ...(c.chunkUid ? { chunkUid: c.chunkUid } : {}),
          }))
        : [];
    },
    agenticSearch: async (query: string) => {
      if (!model.aux.queryRewriter) {
        console.warn('[eval] agenticSearch degraded to plain searchChunks: aux models unavailable (AGENTIC_ENABLED=false)');
        const r = await searchChunks(query, {}, searchDeps);
        return r.ok
          ? r.value.chunks.map((c) => ({
              content: c.content,
              documentId: c.documentId,
              ...(c.documentUid ? { documentUid: c.documentUid } : {}),
              ...(c.chunkUid ? { chunkUid: c.chunkUid } : {}),
            }))
          : [];
      }
      const result = await agenticSearch(query, {
        search: searchDeps,
        queryRewriter: model.aux.queryRewriter,
      });
      return result.ok
        ? result.value.chunks.map((c) => ({
            content: c.content,
            documentId: c.documentId,
            ...(c.documentUid ? { documentUid: c.documentUid } : {}),
            ...(c.chunkUid ? { chunkUid: c.chunkUid } : {}),
          }))
        : [];
    },
    ...model.modelDeps,
  };
}

async function buildDeps(mode: EvalMode, candidateModelId: string): Promise<{
  readonly deps: EvalDeps;
  readonly candidateModelId: string;
  readonly candidateProviderId: string;
}> {
  if (mode === 'mock') {
    return {
      deps: mockEvalDeps(),
      candidateModelId: 'synthetic-mock-model',
      candidateProviderId: 'synthetic',
    };
  }

  const model = await buildRealModelDeps(candidateModelId, mode);
  if (mode === 'real_synthetic') {
    const synthetic = mockEvalDeps();
    if (synthetic.agenticSearch === undefined) {
      throw new Error('[eval] synthetic corpus adapter is missing agentic search');
    }
    return {
      deps: {
        searchChunks: synthetic.searchChunks,
        agenticSearch: synthetic.agenticSearch,
        generate: model.modelDeps.generate,
        gradeFaithfulness: model.modelDeps.gradeFaithfulness,
      },
      candidateModelId: model.candidateModelId,
      candidateProviderId: model.candidateProviderId,
    };
  }

  return {
    deps: await buildLiveRealDeps(model),
    candidateModelId: model.candidateModelId,
    candidateProviderId: model.candidateProviderId,
  };
}

interface GitProvenanceSnapshot {
  readonly trackedIndex: string;
  readonly stagedDiff: string;
  readonly worktreeDiff: string;
  readonly status: string;
  readonly untrackedFilesFingerprint: string;
}

async function resolveUntrackedFilesFingerprint(): Promise<string> {
  const listing = await gitOutput(['ls-files', '--others', '--exclude-standard', '-z']);
  if (listing === 'unavailable') return 'unavailable';
  const paths = listing.split('\u0000').filter((path) => path.length > 0).sort();
  const entries = await Promise.all(paths.map(async (path) => ({
    path,
    contentHash: await gitOutput(['hash-object', '--no-filters', '--', path]),
  })));
  return fingerprintUntrackedFiles(entries);
}

async function resolveGitProvenance(): Promise<GitProvenanceSnapshot> {
  const [trackedIndex, stagedDiff, worktreeDiff, status, untrackedFilesFingerprint] = await Promise.all([
    gitOutput(['ls-files', '-s']),
    gitOutput(['diff', '--cached', '--binary', '--no-ext-diff', '--']),
    gitOutput(['diff', '--binary', '--no-ext-diff', '--']),
    gitOutput(['status', '--porcelain=v1', '--untracked-files=all']),
    resolveUntrackedFilesFingerprint(),
  ]);
  return { trackedIndex, stagedDiff, worktreeDiff, status, untrackedFilesFingerprint };
}

function safeConfigParts(
  mode: EvalMode,
  candidateModelId: string,
  threshold: number,
  interCaseDelayMs: number,
): string[] {
  const observedKeys = [
    'CHAT_PROVIDER',
    'EVAL_CORPUS',
    'EVAL_MODEL_ID',
    'EVAL_INTER_CASE_DELAY_MS',
    'LLM_MODEL',
    'GOOGLE_CHAT_MODEL',
    'OLLAMA_CHAT_MODEL',
    'RERANKER_PROVIDER',
    'AGENTIC_ENABLED',
  ];
  const values = observedKeys.map((key) => `${key}=${process.env[key]?.trim() ?? '<unset>'}`);
  const secretPresence = ['CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_BASE_URL', 'AI_STUDIO_KEY'].map(
    (key) => `${key}=${process.env[key] ? 'present' : 'unset'}`,
  );
  return [
    'config.v1',
    `mode=${mode}`,
    `candidateModelId=${candidateModelId}`,
    `threshold=${threshold}`,
    `interCaseDelayMs=${interCaseDelayMs}`,
    `maxAttempts=${mode === 'real_synthetic' ? REAL_SYNTHETIC_MAX_ATTEMPTS : 1}`,
    `retryDelayMs=${mode === 'real_synthetic' ? REAL_SYNTHETIC_RETRY_DELAY_MS : 0}`,
    ...values,
    ...secretPresence,
  ];
}

function corpusIdentity(mode: EvalMode): { readonly manifestIdentity: string; readonly corpusFingerprint: string } {
  if (mode === 'mock' || mode === 'real_synthetic') {
    return {
      manifestIdentity: SYNTHETIC_MOCK_CORPUS_VERSION,
      corpusFingerprint: fingerprint([
        SYNTHETIC_MOCK_CORPUS_VERSION,
        JSON.stringify(syntheticMockCorpusManifest),
      ]),
    };
  }
  return {
    manifestIdentity: 'live-corpus.unpinned',
    corpusFingerprint: fingerprint(['live-corpus.unpinned', 'labels-unavailable']),
  };
}

function requireCandidateModelId(mode: EvalMode): string {
  if (mode === 'mock') return 'synthetic-mock-model';
  const modelId = configuredModelId();
  if (!modelId) {
    throw new Error(
      `[eval] ${mode} requires an explicit configured chat model id; set EVAL_MODEL_ID or the provider model variable`,
    );
  }
  return modelId;
}

function configuredInterCaseDelayMs(mode: EvalMode): number {
  if (mode !== 'real_synthetic') return 0;
  const raw = process.env.EVAL_INTER_CASE_DELAY_MS?.trim();
  if (!raw) return REAL_SYNTHETIC_INTER_CASE_DELAY_DEFAULT_MS;
  const value = Number(raw);
  if (
    !Number.isInteger(value)
    || value < 0
    || value > REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS
  ) {
    throw new Error(
      `[eval] EVAL_INTER_CASE_DELAY_MS must be an integer in [0, ${REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS}]`,
    );
  }
  return value;
}

function parseTraceFlag(arguments_: readonly string[]): boolean {
  const supported = '--trace-model-interactions';
  if (arguments_.some((argument) => argument !== supported)) {
    throw new Error(`[eval] unknown argument; supported optional flag: ${supported}`);
  }
  if (arguments_.filter((argument) => argument === supported).length > 1) {
    throw new Error(`[eval] ${supported} may be supplied only once`);
  }
  return arguments_.includes(supported);
}

function reportProgress(event: EvalProgressEvent): void {
  if (event.kind === 'attempt_started') {
    console.log(
      `[eval] progress case=${event.caseIndex}/${event.caseCount} id=${event.caseId} attempt=${event.attempt}/${event.maxAttempts} status=started`,
    );
    return;
  }
  if (event.kind === 'attempt_failed') {
    const category = classifyEvalFailure(event.error);
    console.log(
      `[eval] progress case=${event.caseIndex}/${event.caseCount} id=${event.caseId} attempt=${event.attempt}/${event.maxAttempts} status=retryable_failure category=${category}`,
    );
    return;
  }
  console.log(
    `[eval] progress case=${event.caseIndex}/${event.caseCount} id=${event.caseId} attempts=${event.attempts} status=${event.result.passed ? 'passed' : 'baseline_failure'} elapsedMs=${event.result.totalMs.toFixed(1)}`,
  );
  const question = goldenQuestions.find((candidate) => candidate.id === event.caseId);
  writeInteractionTrace({
    kind: 'case_evaluation',
    recordedAt: new Date().toISOString(),
    caseId: event.caseId,
    attempts: event.attempts,
    expected: question === undefined ? null : {
      refusalExpected: question.refusalExpected ?? question.mustMention.length === 0,
      requiredSignals: question.mustMention,
      forbiddenSignals: question.forbidden ?? [],
      expectedDocumentIds: question.expectedMockDocIds ?? [],
      expectedChunkUids: question.expectedMockChunkUids ?? [],
    },
    performed: {
      refused: event.result.refused,
      faithfulness: event.result.faithfulness,
      correctness: event.result.correctness,
      contextRelevancy: event.result.contextRelevancy,
      forbiddenHits: event.result.forbiddenHit,
      documentHit: event.result.hit ?? null,
      chunkHit: event.result.chunkHit ?? null,
      retrievedDocumentIds: event.result.retrievedDocumentIds,
      retrievedDocumentUids: event.result.retrievedDocumentUids,
      retrievedChunkUids: event.result.retrievedChunkUids,
      retrievalMs: event.result.retrievalMs,
      generationMs: event.result.generationMs,
      totalMs: event.result.totalMs,
      passed: event.result.passed,
    },
  });
}

async function main() {
  traceModelInteractions = parseTraceFlag(process.argv.slice(2));
  modelAttemptCounts.clear();
  const rawThreshold = process.env.EVAL_FAITHFULNESS_THRESHOLD ?? '0.7';
  const threshold = Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`[eval] invalid EVAL_FAITHFULNESS_THRESHOLD="${rawThreshold}" — must be a finite number in (0, 1]; failing closed`);
    process.exit(1);
  }
  const useReal = process.env.EVAL_REAL === '1';
  const syntheticCorpusRequested = process.env.EVAL_CORPUS?.trim().toLowerCase() === 'synthetic';
  const mode: EvalMode = useReal
    ? syntheticCorpusRequested ? 'real_synthetic' : 'real'
    : 'mock';
  if (traceModelInteractions && mode !== 'real_synthetic') {
    throw new Error('[eval] --trace-model-interactions is allowed only with EVAL_REAL=1 and EVAL_CORPUS=synthetic');
  }
  if (traceModelInteractions) {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(TRACE_PATH, '', 'utf8');
    console.log(`[eval] synthetic interaction trace enabled: ${TRACE_PATH}`);
  }
  const questions = goldenQuestions;
  const requestedModelId = requireCandidateModelId(mode);
  const interCaseDelayMs = configuredInterCaseDelayMs(mode);
  const built = await buildDeps(mode, requestedModelId);
  const report = await runEval(questions, built.deps, threshold, mode, {
    interCaseDelayMs,
    maxAttempts: REAL_SYNTHETIC_MAX_ATTEMPTS,
    retryDelayMs: REAL_SYNTHETIC_RETRY_DELAY_MS,
    onProgress: reportProgress,
  });
  const baselineCommit = await resolveBaselineCommit();
  const gitProvenance = await resolveGitProvenance();
  const corpus = corpusIdentity(mode);
  const safeCandidateModelId = sanitizeIdentifier(built.candidateModelId);
  const safeCandidateProviderId = sanitizeIdentifier(built.candidateProviderId);
  const goldenReport = buildGoldenReport(report, {
    mode,
    baselineCommit,
    candidateModelId: safeCandidateModelId,
    manifestIdentity: corpus.manifestIdentity,
    sourceFingerprint: fingerprint([
      'source.v1',
      `commit=${baselineCommit}`,
      `trackedIndex=${gitProvenance.trackedIndex}`,
      `stagedDiff=${gitProvenance.stagedDiff}`,
      `worktreeDiff=${gitProvenance.worktreeDiff}`,
      `untrackedFiles=${gitProvenance.untrackedFilesFingerprint}`,
    ]),
    configFingerprint: fingerprint([
      ...safeConfigParts(mode, safeCandidateModelId, threshold, interCaseDelayMs),
      `candidateProviderId=${safeCandidateProviderId}`,
    ]),
    corpusFingerprint: corpus.corpusFingerprint,
    dirtyTreeFingerprint: fingerprint([
      'dirty-tree.v1',
      `status=${gitProvenance.status}`,
      `stagedDiff=${gitProvenance.stagedDiff}`,
      `worktreeDiff=${gitProvenance.worktreeDiff}`,
      `untrackedFiles=${gitProvenance.untrackedFilesFingerprint}`,
    ]),
  });

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
  console.log(`mode: ${mode}`);
  console.log(`candidate model: ${goldenReport.candidateModelId}`);
  console.log(`manifest: ${goldenReport.manifestIdentity}`);
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
  console.log(
    `latency ms (p50/p95/p99): retrieval=${report.latency.retrievalMs.p50 ?? 'n/a'}/${report.latency.retrievalMs.p95 ?? 'n/a'}/${report.latency.retrievalMs.p99 ?? 'n/a'} generation=${report.latency.generationMs.p50 ?? 'n/a'}/${report.latency.generationMs.p95 ?? 'n/a'}/${report.latency.generationMs.p99 ?? 'n/a'} total=${report.latency.totalMs.p50 ?? 'n/a'}/${report.latency.totalMs.p95 ?? 'n/a'}/${report.latency.totalMs.p99 ?? 'n/a'}`,
  );
  console.log('model token usage: unavailable (EvalDeps does not expose provider usage fields)');
  console.log('per-question:');
  for (const r of report.results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.id.padEnd(24)} category=${r.category} mode=${qMode(r.id)} faith=${r.faithfulness} corr=${r.correctness} ctx=${r.contextRelevancy}${r.hit !== undefined ? ` hit=${r.hit ? 'yes' : 'no'}` : ''} hits=${r.retrievedCount} retrievalMs=${r.retrievalMs.toFixed(1)} generationMs=${r.generationMs.toFixed(1)} totalMs=${r.totalMs.toFixed(1)}${r.refused ? ' refused' : ''}${r.forbiddenHit.length ? ` FORBIDDEN=${r.forbiddenHit.join(',')}` : ''}`,
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

type EvalFailureCategory = 'configuration' | 'network' | 'provider' | 'timeout' | 'unknown';

function classifyEvalFailure(error: unknown): EvalFailureCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (/(econnrefused|enotfound|network|fetch|socket)/.test(message)) return 'network';
  if (/(requires|missing|configured|invalid|unknown provider)/.test(message)) return 'configuration';
  if (/(provider|model|api|quota|rate limit|status code)/.test(message)) return 'provider';
  return 'unknown';
}

function safeFailureMessage(category: EvalFailureCategory): string {
  switch (category) {
    case 'configuration':
      return 'evaluation configuration is invalid or incomplete';
    case 'network':
      return 'evaluation provider could not be reached';
    case 'provider':
      return 'evaluation provider request failed';
    case 'timeout':
      return 'evaluation provider request timed out';
    case 'unknown':
      return 'evaluation failed before a report was produced';
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

main().catch((error: unknown) => {
  const category = classifyEvalFailure(error);
  const provider = sanitizeIdentifier(process.env.CHAT_PROVIDER?.trim() || 'unknown');
  console.error(`[eval] failed category=${category} provider=${provider}: ${safeFailureMessage(category)}`);
  process.exitCode = 1;
});
