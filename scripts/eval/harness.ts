import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AnswerCache } from '@app/domain';
import type { GoldenQuestion } from './golden';
import { searchSyntheticMockCorpus } from './mock-corpus';

export type EvalMode = 'mock' | 'real' | 'real_synthetic';

export interface EvalClock {
  readonly now: () => number;
}

const monotonicClock: EvalClock = { now: () => performance.now() };

export interface EvalRetrievedChunk {
  content: string;
  documentId?: number;
  documentUid?: string;
  chunkUid?: string;
}

export interface EvalDeps {
  searchChunks: (query: string) => Promise<EvalRetrievedChunk[]>;
  generate: (query: string, context: string) => Promise<string>;
  gradeFaithfulness: (documents: string, generation: string) => Promise<'yes' | 'no'>;
  /** Optional monotonic clock seam for deterministic latency tests. */
  clock?: EvalClock;
  
  judgeRelevance?: (question: string, snippets: string[]) => Promise<number | null>;
  judgeFaithfulness?: (documents: string, answer: string) => Promise<number | null>;
  
  agenticSearch?: (query: string) => Promise<EvalRetrievedChunk[]>;
}

/**
 * Runtime controls for one evaluation run. real_synthetic always remains
 * serialized so a free-tier candidate provider sees at most one generation
 * in flight. Retries are bounded and apply only when an attempt throws.
 */
export interface EvalRunOptions {
  readonly interCaseDelayMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly onProgress?: (event: EvalProgressEvent) => void;
}

export type EvalProgressEvent =
  | {
      readonly kind: 'attempt_started';
      readonly caseIndex: number;
      readonly caseCount: number;
      readonly caseId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  | {
      readonly kind: 'attempt_failed';
      readonly caseIndex: number;
      readonly caseCount: number;
      readonly caseId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly error: unknown;
    }
  | {
      readonly kind: 'case_completed';
      readonly caseIndex: number;
      readonly caseCount: number;
      readonly caseId: string;
      readonly attempts: number;
      readonly result: EvalResult;
    };

export const REAL_SYNTHETIC_INTER_CASE_DELAY_DEFAULT_MS = 1_000;
export const REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS = 10_000;
export const REAL_SYNTHETIC_MAX_ATTEMPTS = 3;
export const REAL_SYNTHETIC_RETRY_DELAY_MS = 2_000;

/** Return a finite, non-negative delay within the evaluator's safe bound. */
export function normalizeInterCaseDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS);
}

function normalizedMaxAttempts(value: number | undefined): number {
  if (value === undefined) return REAL_SYNTHETIC_MAX_ATTEMPTS;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error('[eval] real-synthetic maxAttempts must be an integer in [1, 5]');
  }
  return value;
}

function normalizedRetryDelayMs(value: number | undefined): number {
  if (value === undefined) return REAL_SYNTHETIC_RETRY_DELAY_MS;
  if (!Number.isInteger(value) || value < 0 || value > REAL_SYNTHETIC_INTER_CASE_DELAY_MAX_MS) {
    throw new Error('[eval] real-synthetic retryDelayMs must be an integer in [0, 10000]');
  }
  return value;
}

async function waitFor(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export interface EvalResult {
  id: string;
  category: GoldenQuestion['category'];
  question: string;
  answer: string;
  retrievedCount: number;
  refusalExpected: boolean;
  refused: boolean;
  faithfulness: number;
  correctness: number;
  contextRelevancy: number;
  forbiddenHit: string[];
  passed: boolean;
  /** True when any retrieved doc id overlaps expectedDocIds; undefined when no expectation set. */
  hit?: boolean;
  /** True when any retrieved stable chunk overlaps an explicitly expected mock chunk; undefined otherwise. */
  chunkHit?: boolean;
  retrievedDocumentIds: number[];
  retrievedDocumentUids: string[];
  retrievedChunkUids: string[];
  retrievalMs: number;
  generationMs: number;
  totalMs: number;
  attempts: number;
  
  judgedRetrievalRelevance: number | null;
  judgedFaithfulness: number | null;
}

const REFUSAL_PHRASES = [
  'cannot answer',
  "can't answer",
  'unable to answer',
  'not able to answer',
  "i don't know",
  'do not have',
  'no information',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary, case-insensitive phrase match (no substring hits). */
export function matchesPhrase(haystack: string, phrase: string): boolean {
  const needle = phrase.trim();
  if (!needle) return false;
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(haystack);
}

function matchedCount(text: string, phrases: string[]): number {
  return phrases.filter((p) => matchesPhrase(text, p)).length;
}

/**
 * Deterministic local faithfulness seam for the real_synthetic run.
 *
 * Every required golden signal must be present in both the retrieved context
 * and the candidate answer. Empty required signals return false so only the
 * refusal branch can credit out-of-scope questions. No provider call or
 * fallback is involved.
 */
export function hasRequiredSignalsInContextAndAnswer(
  requiredSignals: readonly string[],
  context: string,
  answer: string,
): boolean {
  if (requiredSignals.length === 0) return false;
  return requiredSignals.every((signal) =>
    matchesPhrase(context, signal) && matchesPhrase(answer, signal),
  );
}

/** A generation that declines to answer from the given context. */
export function isRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_PHRASES.some((p) => lower.includes(p));
}

/** Requires ≥ 2 distinct (case-insensitive, non-empty) phrases. */
export function isDistinctPhrases(phrases: string[]): boolean {
  return new Set(phrases.map((p) => p.trim().toLowerCase()).filter(Boolean)).size >= 2;
}

export function isDocHit(actualDocIds: readonly number[], expectedDocIds: readonly number[]): boolean {
  const expected = new Set(expectedDocIds);
  return actualDocIds.some((id) => expected.has(id));
}

export function isChunkHit(actualChunkUids: readonly string[], expectedChunkUids: readonly string[]): boolean {
  const expected = new Set(expectedChunkUids);
  return actualChunkUids.some((uid) => expected.has(uid));
}

function elapsedMs(start: number, end: number): number {
  const elapsed = end - start;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function usesSyntheticCorpus(mode: EvalMode): boolean {
  return mode === 'mock' || mode === 'real_synthetic';
}

export async function evaluateOne(
  q: GoldenQuestion,
  deps: EvalDeps,
  expectationMode: EvalMode = 'real',
): Promise<EvalResult> {
  const clock = deps.clock ?? monotonicClock;
  const totalStartedAt = clock.now();
  const retrievalStartedAt = totalStartedAt;
  const agenticSearch = deps.agenticSearch;
  const useAgentic = q.mode === 'agentic' && typeof agenticSearch === 'function';
  if (q.mode === 'agentic' && !useAgentic) {
    console.warn(`[eval] agentic question "${q.id}" degraded to plain searchChunks: agenticSearch unavailable`);
  }
  const retrieved = useAgentic
    ? await agenticSearch(q.question)
    : await deps.searchChunks(q.question);
  const retrievalFinishedAt = clock.now();
  const context = retrieved.map((r) => r.content).join('\n\n');
  const generationStartedAt = retrievalFinishedAt;
  const answer = await deps.generate(q.question, context);
  const generationFinishedAt = clock.now();
  const refusalExpected = q.refusalExpected ?? q.mustMention.length === 0;
  const refused = isRefusal(answer);

  let faithfulness = 0;
  if (refused) {
    faithfulness = refusalExpected ? 1 : 0;
  } else if (expectationMode === 'real_synthetic') {
    faithfulness = hasRequiredSignalsInContextAndAnswer(q.mustMention, context, answer) ? 1 : 0;
  } else if (retrieved.length > 0) {
    const verdict = await deps.gradeFaithfulness(context, answer);
    faithfulness = verdict === 'yes' ? 1 : 0;
  }

  const judgedRetrievalRelevance =
    expectationMode !== 'real_synthetic' && typeof deps.judgeRelevance === 'function'
      ? await deps.judgeRelevance(q.question, retrieved.map((r) => r.content))
      : null;
  const judgedFaithfulness =
    expectationMode !== 'real_synthetic' && typeof deps.judgeFaithfulness === 'function'
      ? await deps.judgeFaithfulness(context, answer)
      : null;

  // `totalMs` describes the interactive path a user waits for: retrieval plus
  // answer generation.  Judge calls are evaluation-only work and happen after
  // this boundary, so they must not inflate the reported turn latency.
  const interactiveTotalMs = elapsedMs(totalStartedAt, generationFinishedAt);

  const actualDocIds = retrieved
    .map((r) => r.documentId)
    .filter((id): id is number => typeof id === 'number');
  const actualDocumentUids = retrieved
    .map((r) => r.documentUid)
    .filter((uid): uid is string => typeof uid === 'string');
  const actualChunkUids = retrieved
    .map((r) => r.chunkUid)
    .filter((uid): uid is string => typeof uid === 'string');
  const expectedDocIds =
    usesSyntheticCorpus(expectationMode) ? q.expectedMockDocIds : q.expectedDocIds;
  const hit = expectedDocIds ? isDocHit(actualDocIds, expectedDocIds) : undefined;
  const expectedChunkUids = usesSyntheticCorpus(expectationMode)
    ? q.expectedMockChunkUids
    : undefined;
  const chunkHit = expectedChunkUids
    ? isChunkHit(actualChunkUids, expectedChunkUids)
    : undefined;

  const correctness =
    q.mustMention.length === 0
      ? 1
      : matchedCount(answer, q.mustMention) / q.mustMention.length;
  const contextRelevancy =
    q.mustMention.length === 0
      ? 1
      : matchedCount(context, q.mustMention) / q.mustMention.length;
  const forbiddenHit = (q.forbidden ?? []).filter((p) =>
    matchesPhrase(answer, p),
  );
  const refusalConsistent = refused === refusalExpected;

  return {
    id: q.id,
    category: q.category,
    question: q.question,
    answer,
    retrievedCount: retrieved.length,
    refusalExpected,
    refused,
    faithfulness,
    correctness,
    contextRelevancy,
    forbiddenHit,
    passed:
      refusalConsistent &&
      faithfulness === 1 &&
      forbiddenHit.length === 0 &&
      correctness >= 0.5,
    ...(hit !== undefined ? { hit } : {}),
    ...(chunkHit !== undefined ? { chunkHit } : {}),
    retrievedDocumentIds: actualDocIds,
    retrievedDocumentUids: actualDocumentUids,
    retrievedChunkUids: actualChunkUids,
    retrievalMs: elapsedMs(retrievalStartedAt, retrievalFinishedAt),
    generationMs: elapsedMs(generationStartedAt, generationFinishedAt),
    totalMs: interactiveTotalMs,
    attempts: 1,
    judgedRetrievalRelevance,
    judgedFaithfulness,
  };
}

export interface EvalReport {
  results: EvalResult[];
  meanFaithfulness: number;
  meanCorrectness: number;
  meanContextRelevancy: number;
  passed: boolean;
  threshold: number;
  
  hits: number;
  passRate: number;
  /** False when no question set expectedDocIds — passRate is vacuous [F5]. */
  docHitGateActive: boolean;
  avgFaithfulnessJudge: number | null;
  avgRetrievalRelevanceJudge: number | null;
  latency: EvalLatencyReport;
}

export interface EvalLatencyPercentiles {
  readonly scope: 'all_cases';
  readonly unit: 'milliseconds';
  readonly sampleCount: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface EvalLatencyReport {
  readonly retrievalMs: EvalLatencyPercentiles;
  readonly generationMs: EvalLatencyPercentiles;
  readonly totalMs: EvalLatencyPercentiles;
}

export async function runEval(
  questions: readonly GoldenQuestion[],
  deps: EvalDeps,
  threshold: number,
  expectationMode: EvalMode = 'real',
  options: EvalRunOptions = {},
): Promise<EvalReport> {
  const concurrency = expectationMode === 'real_synthetic' ? 1 : 5;
  const interCaseDelayMs = expectationMode === 'real_synthetic'
    ? normalizeInterCaseDelayMs(options.interCaseDelayMs)
    : 0;
  const maxAttempts = expectationMode === 'real_synthetic'
    ? normalizedMaxAttempts(options.maxAttempts)
    : 1;
  const retryDelayMs = expectationMode === 'real_synthetic'
    ? normalizedRetryDelayMs(options.retryDelayMs)
    : 0;
  const results: EvalResult[] = [];
  if (concurrency === 1) {
    for (const [index, question] of questions.entries()) {
      if (index > 0 && interCaseDelayMs > 0) {
        await waitFor(interCaseDelayMs);
      }
      const retryStartedAt = performance.now();
      let result: EvalResult | undefined;
      let attemptsUsed = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        attemptsUsed = attempt;
        options.onProgress?.({
          kind: 'attempt_started',
          caseIndex: index + 1,
          caseCount: questions.length,
          caseId: question.id,
          attempt,
          maxAttempts,
        });
        try {
          result = await evaluateOne(question, deps, expectationMode);
          break;
        } catch (error: unknown) {
          options.onProgress?.({
            kind: 'attempt_failed',
            caseIndex: index + 1,
            caseCount: questions.length,
            caseId: question.id,
            attempt,
            maxAttempts,
            error,
          });
          if (attempt === maxAttempts) {
            throw new Error('[eval] real-synthetic case failed after bounded provider retries');
          }
          await waitFor(retryDelayMs);
        }
      }
      if (result === undefined) {
        throw new Error('[eval] real-synthetic case produced no result');
      }
      const retriedTotalMs = elapsedMs(retryStartedAt, performance.now());
      if (attemptsUsed > 1 && retriedTotalMs > result.totalMs) {
        const retryOverheadMs = retriedTotalMs - result.totalMs;
        result = {
          ...result,
          generationMs: result.generationMs + retryOverheadMs,
          totalMs: retriedTotalMs,
          attempts: attemptsUsed,
        };
      } else if (attemptsUsed > 1) {
        result = { ...result, attempts: attemptsUsed };
      }
      results.push(result);
      options.onProgress?.({
        kind: 'case_completed',
        caseIndex: index + 1,
        caseCount: questions.length,
        caseId: question.id,
        attempts: attemptsUsed,
        result,
      });
    }
  } else {
    for (let i = 0; i < questions.length; i += concurrency) {
      const batch = questions.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((question, batchIndex) => {
          options.onProgress?.({
            kind: 'attempt_started',
            caseIndex: i + batchIndex + 1,
            caseCount: questions.length,
            caseId: question.id,
            attempt: 1,
            maxAttempts: 1,
          });
          return evaluateOne(question, deps, expectationMode);
        }),
      );
      results.push(...batchResults);
      for (const [batchIndex, result] of batchResults.entries()) {
        options.onProgress?.({
          kind: 'case_completed',
          caseIndex: i + batchIndex + 1,
          caseCount: questions.length,
          caseId: result.id,
          attempts: 1,
          result,
        });
      }
    }
  }
  return { ...aggregate(results, threshold) };
}

function isValidThreshold(v: number): boolean {
  return Number.isFinite(v) && v > 0 && v <= 1;
}

export function aggregate(
  results: EvalResult[],
  threshold: number,
): EvalReport {
  if (!isValidThreshold(threshold)) {
    console.warn(`[eval] invalid threshold ${String(threshold)} — must be finite in (0,1]; treating as gate failure`);
  }
  const thresholdValid = isValidThreshold(threshold);
  const mean = (sel: (r: EvalResult) => number) =>
    results.length ? results.reduce((acc, r) => acc + sel(r), 0) / results.length : 0;
  const meanFaithfulness = mean((r) => r.faithfulness);
  const meanCorrectness = mean((r) => r.correctness);
  const meanContextRelevancy = mean((r) => r.contextRelevancy);

  const withExpectation = results.filter((r) => r.hit !== undefined);
  const hits = withExpectation.filter((r) => r.hit === true).length;
  const docHitGateActive = withExpectation.length > 0;

  const judgedFaithful = results
    .map((r) => r.judgedFaithfulness)
    .filter((v): v is number => v !== null);
  const judgedRelevant = results
    .map((r) => r.judgedRetrievalRelevance)
    .filter((v): v is number => v !== null);

  const latencyPercentiles = (
    select: (result: EvalResult) => number,
  ): EvalLatencyPercentiles => {
    const values = results
      .map(select)
      .filter((value): value is number => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const percentile = (fraction: number): number | null => {
      if (values.length === 0) return null;
      const position = (values.length - 1) * fraction;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      if (lower === upper) return values[lower] ?? null;
      const lowerValue = values[lower];
      const upperValue = values[upper];
      if (lowerValue === undefined || upperValue === undefined) return null;
      const interpolated = lowerValue + (upperValue - lowerValue) * (position - lower);
      return Math.round(interpolated * 1_000) / 1_000;
    };
    return {
      scope: 'all_cases',
      unit: 'milliseconds',
      sampleCount: values.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  };

  return {
    results,
    meanFaithfulness,
    meanCorrectness,
    meanContextRelevancy,
    passed: thresholdValid && meanFaithfulness >= threshold,
    threshold,
    hits,
    passRate: withExpectation.length > 0 ? hits / withExpectation.length : 1,
    docHitGateActive,
    avgFaithfulnessJudge:
      judgedFaithful.length > 0
        ? judgedFaithful.reduce((a, b) => a + b, 0) / judgedFaithful.length
        : null,
    avgRetrievalRelevanceJudge:
      judgedRelevant.length > 0
        ? judgedRelevant.reduce((a, b) => a + b, 0) / judgedRelevant.length
        : null,
    latency: {
      retrievalMs: latencyPercentiles((result) => result.retrievalMs),
      generationMs: latencyPercentiles((result) => result.generationMs),
      totalMs: latencyPercentiles((result) => result.totalMs),
    },
  };
}

export const GOLDEN_REPORT_SCHEMA_VERSION = 'golden-report.v1';

export interface GoldenReportMetadata {
  readonly mode: EvalMode;
  readonly baselineCommit: string;
  readonly candidateModelId: string;
  readonly manifestIdentity: string;
  readonly sourceFingerprint: string;
  readonly configFingerprint: string;
  readonly corpusFingerprint: string;
  readonly dirtyTreeFingerprint: string;
}

export interface GoldenModelUsage {
  readonly scope: 'all_model_calls';
  readonly unit: 'tokens';
  readonly sampleCount: 0;
  readonly status: 'unavailable';
  readonly inputTokens: null;
  readonly outputTokens: null;
  readonly cacheReadTokens: null;
  readonly cacheWriteTokens: null;
}

export interface GoldenReport {
  schemaVersion: typeof GOLDEN_REPORT_SCHEMA_VERSION;
  mode: EvalMode;
  baselineCommit: string;
  candidateModelId: string;
  manifestIdentity: string;
  sourceFingerprint: string;
  configFingerprint: string;
  corpusFingerprint: string;
  dirtyTreeFingerprint: string;
  total: number;
  hits: number;
  passRate: number;
  /** False when no golden question defines expectedDocIds; passRate is vacuous. */
  docHitGateActive: boolean;
  avgFaithfulness: number | null;
  avgRetrievalRelevance: number | null;
  meanFaithfulness: number;
  meanCorrectness: number;
  meanContextRelevancy: number;
  threshold: number;
  passed: boolean;
  generatedAt: string;
  latency: EvalLatencyReport;
  modelUsage: GoldenModelUsage;
}

/** Deterministic SHA-256 fingerprint for report provenance inputs. */
export function fingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,95}$/;

/**
 * Keeps ordinary provider/model ids readable while preventing arbitrary
 * endpoint, query-string, or secret-shaped values from entering reports.
 */
export function sanitizeIdentifier(value: string): string {
  const normalized = value.trim();
  if (SAFE_IDENTIFIER_PATTERN.test(normalized)) return normalized;
  return `redacted-${fingerprint([normalized]).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

export interface UntrackedFileFingerprintInput {
  readonly path: string;
  readonly contentHash: string;
}

/** Fingerprints untracked source by path and precomputed content hash, never by raw content. */
export function fingerprintUntrackedFiles(
  entries: readonly UntrackedFileFingerprintInput[],
): string {
  const normalized = [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\u0000${entry.contentHash}`);
  return fingerprint(['untracked-files.v1', ...normalized]);
}

function ensureReportMetadata(metadata: GoldenReportMetadata): void {
  const required: readonly (readonly [string, string])[] = [
    ['baselineCommit', metadata.baselineCommit],
    ['candidateModelId', metadata.candidateModelId],
    ['manifestIdentity', metadata.manifestIdentity],
    ['sourceFingerprint', metadata.sourceFingerprint],
    ['configFingerprint', metadata.configFingerprint],
    ['corpusFingerprint', metadata.corpusFingerprint],
    ['dirtyTreeFingerprint', metadata.dirtyTreeFingerprint],
  ];
  for (const [name, value] of required) {
    if (value.trim() === '') throw new Error(`[eval] report metadata ${name} must not be empty`);
  }
}

export function buildGoldenReport(
  report: EvalReport,
  metadata: GoldenReportMetadata,
): GoldenReport {
  ensureReportMetadata(metadata);
  const safeCandidateModelId = sanitizeIdentifier(metadata.candidateModelId);
  return {
    schemaVersion: GOLDEN_REPORT_SCHEMA_VERSION,
    mode: metadata.mode,
    baselineCommit: metadata.baselineCommit,
    candidateModelId: safeCandidateModelId,
    manifestIdentity: metadata.manifestIdentity,
    sourceFingerprint: metadata.sourceFingerprint,
    configFingerprint: metadata.configFingerprint,
    corpusFingerprint: metadata.corpusFingerprint,
    dirtyTreeFingerprint: metadata.dirtyTreeFingerprint,
    total: report.results.length,
    hits: report.hits,
    passRate: report.passRate,
    docHitGateActive: report.docHitGateActive,
    avgFaithfulness: report.avgFaithfulnessJudge,
    avgRetrievalRelevance: report.avgRetrievalRelevanceJudge,
    meanFaithfulness: report.meanFaithfulness,
    meanCorrectness: report.meanCorrectness,
    meanContextRelevancy: report.meanContextRelevancy,
    threshold: report.threshold,
    passed: report.passed,
    generatedAt: new Date().toISOString(),
    latency: report.latency,
    modelUsage: {
      scope: 'all_model_calls',
      unit: 'tokens',
      sampleCount: 0,
      status: 'unavailable',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
  };
}

export function evalGateFailure(report: EvalReport): string | null {
  if (!isValidThreshold(report.threshold)) {
    return `invalid threshold ${String(report.threshold)} — must be in (0,1]`;
  }
  if (!report.passed) {
    return `mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (!report.docHitGateActive) {
    return 'document-hit gate is inactive because no retrieval case has an expected document label';
  }
  if (report.meanFaithfulness < report.threshold) {
    return `mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (
    report.avgFaithfulnessJudge !== null &&
    report.avgFaithfulnessJudge < report.threshold
  ) {
    return `judge faithfulness ${report.avgFaithfulnessJudge.toFixed(2)} < threshold ${report.threshold}`;
  }
  if (report.passRate < PASS_RATE_MIN) {
    return `passRate ${(report.passRate * 100).toFixed(0)}% < ${PASS_RATE_MIN * 100}%`;
  }
  return null;
}

const PASS_RATE_MIN = 0.8;

/** Mock deps for CI: deterministic, no network/DB. */
export function mockEvalDeps(): EvalDeps & { cache: AnswerCache } {
  const cacheStore = new Map<string, string>();
  const search = async (query: string): Promise<EvalRetrievedChunk[]> =>
    searchSyntheticMockCorpus(query);
  return {
    cache: {
      async get(key: string) {
        return cacheStore.get(key) ?? null;
      },
      async set(key: string, value: string) {
        cacheStore.set(key, value);
      },
    },
    async searchChunks(query: string) {
      return search(query);
    },
    async agenticSearch(query: string) {
      const base = await search(query);
      return base.map((r) => ({ ...r, content: `[agentic] ${r.content}` }));
    },
    async generate(_query: string, context: string) {
      return context
        ? `Based on the synthetic docs: ${context}`
        : 'I cannot answer that from the available docs.';
    },
    async gradeFaithfulness(documents: string, generation: string) {
      return documents.trim() === '' || generation.trim() === '' ? 'no' : 'yes';
    },
  };
}
