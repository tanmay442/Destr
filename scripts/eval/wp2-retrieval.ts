import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import type { RetrievedChunkRow } from '@app/domain';
import { searchChunks, type SearchDeps } from '@app/application';
import { closePool, db } from '../../packages/infrastructure/src/db/client';
import { createChunkStore } from '../../packages/infrastructure/src/db/chunk-store';
import { createLexicalSearch } from '../../packages/infrastructure/src/db/lexical-search';
import { insertDocument } from '../../packages/infrastructure/src/db/repositories';
import { VECTOR_DIM } from '../../packages/infrastructure/src/db/schema-vector';
import type { Client } from '../../packages/infrastructure/src/db/client';
import { candidateSourceProvenance, fileSha256, sha256Json } from './wp2-provenance';

const REPORT_PATH = join('eval', 'wp2-retrieval-report.json');
const ROLLBACK = '__WP2_EVAL_ROLLBACK__';

interface EvalCase {
  readonly id: string;
  readonly category: 'error_code' | 'title' | 'section' | 'phrase' | 'boolean_or' | 'no_match';
  readonly query: string;
  readonly relevantDocumentIds: readonly number[];
}

interface RankedCase {
  readonly id: string;
  readonly category: EvalCase['category'];
  readonly query: string;
  readonly relevantDocumentIds: readonly number[];
  readonly returnedDocumentIds: readonly number[];
  readonly candidateCount: number;
  readonly latencyMs: number;
}

const CORPUS_DOCUMENTS = [
  { key: 'error-code', title: 'ERR-4291 Rate Limit', sectionTitle: 'API errors', content: 'Wait briefly and retry the request.' },
  { key: 'account-recovery', title: 'Account Recovery', content: 'Follow the verified workflow.' },
  { key: 'password-reset', sectionTitle: 'Password Reset', content: 'Use the recovery workflow.' },
  { key: 'exact-phrase', content: 'reset password now' },
  { key: 'phrase-distractor', content: 'reset the account, then choose a new password' },
  { key: 'refund', content: 'refund processing guidance' },
  { key: 'chargeback', content: 'chargeback dispute guidance' },
] as const;

const CASE_SPECS = [
  { id: 'error-code-title', category: 'error_code', query: 'ERR-4291', relevantKeys: ['error-code'] },
  { id: 'title-hit', category: 'title', query: 'account recovery', relevantKeys: ['account-recovery'] },
  { id: 'section-hit', category: 'section', query: 'password reset', relevantKeys: ['password-reset'] },
  { id: 'quoted-phrase', category: 'phrase', query: '"reset password"', relevantKeys: ['exact-phrase'] },
  { id: 'boolean-or', category: 'boolean_or', query: 'refund OR chargeback', relevantKeys: ['refund', 'chargeback'] },
  { id: 'no-match', category: 'no_match', query: 'ZXQJ nonexistent', relevantKeys: [] },
] as const;

const EVALUATION_CONFIG = {
  language: 'english',
  resultLimit: 10,
  baseline: { mode: 'content_plain', queryParser: 'plainto_tsquery', ranker: 'ts_rank' },
  candidate: {
    mode: 'weighted_websearch',
    queryParser: 'websearch_to_tsquery',
    ranker: 'ts_rank_cd',
    weights: { title: 'A', sectionTitle: 'B', content: 'D' },
  },
  gates: { recallAt5: 0.9, mrrAt10: 0.8, noMatchPrecision: 0.95, noMatchRecall: 0.9, maxNdcgRegression: 0.02 },
} as const;

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = ordered[lower] ?? 0;
  const high = ordered[upper] ?? low;
  return Math.round((low + (high - low) * (position - lower)) * 1_000) / 1_000;
}

function recallAt(result: RankedCase, k: number): number {
  if (result.relevantDocumentIds.length === 0) return 1;
  const returned = new Set(result.returnedDocumentIds.slice(0, k));
  const hits = result.relevantDocumentIds.filter((id) => returned.has(id)).length;
  return hits / result.relevantDocumentIds.length;
}

function reciprocalRank(result: RankedCase): number {
  const relevant = new Set(result.relevantDocumentIds);
  const rank = result.returnedDocumentIds.slice(0, 10).findIndex((id) => relevant.has(id));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

function ndcg(result: RankedCase): number {
  if (result.relevantDocumentIds.length === 0) return 1;
  const relevant = new Set(result.relevantDocumentIds);
  const dcg = result.returnedDocumentIds.slice(0, 10).reduce(
    (total, id, index) => total + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const ideal = Array.from(
    { length: Math.min(result.relevantDocumentIds.length, 10) },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((total, value) => total + value, 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

function metrics(results: readonly RankedCase[]) {
  const answerable = results.filter((result) => result.relevantDocumentIds.length > 0);
  const noMatch = results.filter((result) => result.relevantDocumentIds.length === 0);
  const mean = (values: readonly number[]) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  const predictedNoMatch = results.filter((result) => result.returnedDocumentIds.length === 0);
  const trueNoMatch = predictedNoMatch.filter((result) => result.relevantDocumentIds.length === 0).length;
  return {
    recallAt1: mean(answerable.map((result) => recallAt(result, 1))),
    recallAt3: mean(answerable.map((result) => recallAt(result, 3))),
    recallAt5: mean(answerable.map((result) => recallAt(result, 5))),
    recallAt10: mean(answerable.map((result) => recallAt(result, 10))),
    mrrAt10: mean(answerable.map(reciprocalRank)),
    ndcgAt10: mean(answerable.map(ndcg)),
    noMatchPrecision: predictedNoMatch.length === 0 ? 1 : trueNoMatch / predictedNoMatch.length,
    noMatchRecall: noMatch.length === 0 ? 1 : trueNoMatch / noMatch.length,
    latencyMs: {
      sampleCount: results.length,
      p50: percentile(results.map((result) => result.latencyMs), 0.5),
      p95: percentile(results.map((result) => result.latencyMs), 0.95),
      p99: percentile(results.map((result) => result.latencyMs), 0.99),
    },
    meanCandidateCount: mean(results.map((result) => result.candidateCount)),
  };
}

function ndcgByCategory(results: readonly RankedCase[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(results.filter((result) => result.relevantDocumentIds.length > 0).map((result) => result.category))]
      .sort()
      .map((category) => {
        const categoryResults = results.filter((result) => result.category === category);
        return [category, categoryResults.reduce((sum, result) => sum + ndcg(result), 0) / categoryResults.length];
      }),
  );
}

async function seedChunk(
  client: Client,
  input: { title?: string; sectionTitle?: string; content: string },
): Promise<number> {
  const document = await insertDocument({
    fileName: `wp2-eval-${randomUUID()}.pdf`,
    fileHash: randomUUID(),
    uploadedBy: 'wp2-synthetic-eval',
  }, client);
  await createChunkStore(client).insertMany([{
    documentId: document.id,
    chunkIndex: 0,
    kind: 'child',
    title: input.title ?? null,
    sectionTitle: input.sectionTitle ?? null,
    content: input.content,
    embedding: Array.from({ length: VECTOR_DIM }, () => 0),
  }]);
  return document.id;
}

async function evaluateMode(
  client: Client,
  cases: readonly EvalCase[],
  mode: 'content_plain' | 'weighted_websearch',
): Promise<RankedCase[]> {
  const lexical = createLexicalSearch(client);
  const results: RankedCase[] = [];
  for (const evalCase of cases) {
    const startedAt = performance.now();
    const rows = await lexical.searchByLexical(evalCase.query, { limit: 10, mode });
    results.push({
      id: evalCase.id,
      category: evalCase.category,
      query: evalCase.query,
      relevantDocumentIds: evalCase.relevantDocumentIds,
      returnedDocumentIds: rows.map((row) => row.documentId),
      candidateCount: rows.length,
      latencyMs: performance.now() - startedAt,
    });
  }
  return results;
}

function syntheticRow(id: number, chunkUid: string): RetrievedChunkRow {
  return {
    id,
    chunkUid,
    documentId: 1,
    fileName: 'synthetic.pdf',
    page: null,
    sectionTitle: null,
    source: null,
    title: null,
    content: `synthetic evidence ${id}`,
    similarity: 1 - id / 100,
    parentChunkId: null,
    chunkIndex: id,
  };
}

async function evaluateBackfill() {
  const rows = [syntheticRow(1, 'seen'), syntheticRow(2, 'two'), syntheticRow(3, 'three')];
  const deps: SearchDeps = {
    chunks: {
      insertMany: async () => undefined,
      deleteByDocumentId: async () => undefined,
      searchByVector: async () => rows,
      searchByLexical: async () => [],
      getByIds: async () => [],
      getByDocAndRange: async () => [],
      getByDocAndRanges: async () => new Map(),
      countForDocuments: async () => new Map(),
      countForAll: async () => 0,
      countForDocument: async () => 0,
      recountAll: async () => [],
    },
    embeddings: {
      embed: async () => [1],
      embedBatch: async () => [[1]],
    },
  };
  const result = await searchChunks('synthetic backfill', {
    hybridEnabled: false,
    limit: 2,
    candidateLimit: 3,
    excludeChunkIdentities: new Set(['chunk_uid:seen']),
  }, deps);
  if (!result.ok) throw result.error;
  const succeeded = result.value.chunks.map((chunk) => chunk.chunkUid).join(',') === 'two,three';
  return {
    cases: 1,
    successes: succeeded ? 1 : 0,
    successRate: succeeded ? 1 : 0,
    diagnostics: result.value.diagnostics,
  };
}

async function main(): Promise<void> {
  let comparison: { baseline: RankedCase[]; candidate: RankedCase[] } | undefined;
  let databaseVersion = 'unknown';
  try {
    await db.transaction(async (tx) => {
      const client = tx as Client;
      const version = await client.execute(sql`SELECT current_setting('server_version') AS version`);
      databaseVersion = String(version.rows[0]?.version ?? 'unknown');
      const documentIds = new Map<string, number>();
      for (const document of CORPUS_DOCUMENTS) {
        documentIds.set(document.key, await seedChunk(client, document));
      }
      const cases: EvalCase[] = CASE_SPECS.map((evalCase) => ({
        id: evalCase.id,
        category: evalCase.category,
        query: evalCase.query,
        relevantDocumentIds: evalCase.relevantKeys.map((key) => {
          const id = documentIds.get(key);
          if (id === undefined) throw new Error(`Missing synthetic document key: ${key}`);
          return id;
        }),
      }));
      comparison = {
        baseline: await evaluateMode(client, cases, 'content_plain'),
        candidate: await evaluateMode(client, cases, 'weighted_websearch'),
      };
      throw new Error(ROLLBACK);
    });
  } catch (cause) {
    if (!(cause instanceof Error) || cause.message !== ROLLBACK) throw cause;
  }
  if (!comparison) throw new Error('WP-2 retrieval evaluation did not run');

  const baseline = metrics(comparison.baseline);
  const candidate = metrics(comparison.candidate);
  const baselineNdcgByCategory = ndcgByCategory(comparison.baseline);
  const candidateNdcgByCategory = ndcgByCategory(comparison.candidate);
  const perCategoryNdcgRegressions = Object.fromEntries(
    Object.keys(candidateNdcgByCategory).map((category) => [
      category,
      Math.max(0, (baselineNdcgByCategory[category] ?? 0) - (candidateNdcgByCategory[category] ?? 0)),
    ]),
  );
  const p95LatencyRegression = baseline.latencyMs.p95 === 0
    ? 0
    : (candidate.latencyMs.p95 - baseline.latencyMs.p95) / baseline.latencyMs.p95;
  const backfill = await evaluateBackfill();
  const source = candidateSourceProvenance();
  const report = {
    schemaVersion: 'wp2-retrieval-report.v2',
    generatedAt: new Date().toISOString(),
    provenance: {
      ...source,
      corpus: 'synthetic-wp2-lexical.v1',
      corpusSha256: sha256Json({ documents: CORPUS_DOCUMENTS, cases: CASE_SPECS }),
      effectiveConfig: EVALUATION_CONFIG,
      effectiveConfigSha256: sha256Json(EVALUATION_CONFIG),
      migration: 'drizzle/0032_curious_odin.sql',
      migrationSha256: fileSha256('drizzle/0032_curious_odin.sql'),
      schemaSha256: fileSha256('packages/infrastructure/src/db/schema.ts'),
      databaseVersion,
    },
    comparison: {
      baseline: {
        mode: 'content_plain', metrics: baseline, ndcgAt10ByCategory: baselineNdcgByCategory, cases: comparison.baseline,
      },
      candidate: {
        mode: 'weighted_websearch', metrics: candidate, ndcgAt10ByCategory: candidateNdcgByCategory, cases: comparison.candidate,
      },
    },
    gates: {
      recallAt5: { required: 0.9, actual: candidate.recallAt5, passed: candidate.recallAt5 >= 0.9 },
      mrrAt10: { required: 0.8, actual: candidate.mrrAt10, passed: candidate.mrrAt10 >= 0.8 },
      noMatchPrecision: {
        required: 0.95,
        actual: candidate.noMatchPrecision,
        passed: candidate.noMatchPrecision >= 0.95,
      },
      noMatchRecall: {
        required: 0.9,
        actual: candidate.noMatchRecall,
        passed: candidate.noMatchRecall >= 0.9,
      },
      ndcgRegression: {
        maximum: 0.02,
        actual: Math.max(0, baseline.ndcgAt10 - candidate.ndcgAt10),
        passed: candidate.ndcgAt10 >= baseline.ndcgAt10 - 0.02,
      },
      perCategoryNdcgRegression: {
        maximum: 0.02,
        actual: perCategoryNdcgRegressions,
        passed: Object.values(perCategoryNdcgRegressions).every((regression) => regression <= 0.02),
      },
      p95LatencyRegression: {
        maximum: 0.15,
        actual: p95LatencyRegression,
        passed: p95LatencyRegression <= 0.15,
      },
      backfillSuccess: { required: 1, actual: backfill.successRate, passed: backfill.successRate === 1 },
    },
    backfill,
    limitations: [
      'Synthetic corpus only; no production query text or production data was used.',
      'Latency is local PostgreSQL evidence, not a deployment capacity measurement.',
      'Production-corpus reranker calibration remains deployment-specific; 0.5 is supported only by the recorded synthetic probe.',
    ],
  };
  mkdirSync('eval', { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const failed = Object.values(report.gates).filter((gate) => !gate.passed);
  console.log(JSON.stringify({ report: REPORT_PATH, gates: report.gates }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

void main()
  .catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : 'WP-2 retrieval evaluation failed');
    process.exitCode = 1;
  })
  .finally(async () => closePool());
