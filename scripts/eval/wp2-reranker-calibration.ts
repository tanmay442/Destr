import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvSource } from '@app/domain';
import { createLocalReranker } from '../../packages/infrastructure/src/llm/local-reranker';
import { candidateSourceProvenance, fileSha256, sha256Json } from './wp2-provenance';

const FIXTURE_PATH = join('scripts', 'eval', 'fixtures', 'wp2-reranker-calibration.json');
const REPORT_PATH = join('eval', 'wp2-reranker-calibration-report.json');
const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
const THRESHOLD = 0.5;

interface CalibrationCase {
  readonly id: string;
  readonly label: 'positive' | 'negative';
  readonly query: string;
  readonly document: string;
}

interface CalibrationFixture {
  readonly schemaVersion: string;
  readonly cases: readonly CalibrationCase[];
}

function parseFixture(): CalibrationFixture {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Partial<CalibrationFixture>;
  if (typeof parsed.schemaVersion !== 'string' || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error('Invalid WP-2 reranker calibration fixture');
  }
  const ids = new Set<string>();
  for (const item of parsed.cases) {
    if (
      typeof item?.id !== 'string' || ids.has(item.id)
      || (item.label !== 'positive' && item.label !== 'negative')
      || typeof item.query !== 'string' || typeof item.document !== 'string'
    ) {
      throw new Error('Invalid or duplicate WP-2 reranker calibration case');
    }
    ids.add(item.id);
  }
  return parsed as CalibrationFixture;
}

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join('packages', 'infrastructure', 'node_modules', '@xenova', 'transformers', 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('Unable to resolve @xenova/transformers version');
  return manifest.version;
}

async function main(): Promise<void> {
  const fixture = parseFixture();
  const processEnv: EnvSource = {
    get: (key) => key === 'LOCAL_RERANK_MODEL' ? MODEL_ID : process.env[key],
  };
  const reranker = createLocalReranker(processEnv);
  const scored: Array<CalibrationCase & { score: number; predicted: 'positive' | 'negative' }> = [];
  const grouped = new Map<string, CalibrationCase[]>();
  for (const item of fixture.cases) {
    const cases = grouped.get(item.query);
    if (cases) cases.push(item);
    else grouped.set(item.query, [item]);
  }
  for (const [query, cases] of grouped) {
    const ranked = await reranker.rank(query, cases.map((item) => item.document));
    const scoreByIndex = new Map(ranked.map((item) => [item.index, item.relevanceScore]));
    for (const [index, item] of cases.entries()) {
      const score = scoreByIndex.get(index);
      if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(`Invalid reranker score for ${item.id}`);
      }
      scored.push({ ...item, score, predicted: score >= THRESHOLD ? 'positive' : 'negative' });
    }
  }
  const falsePositives = scored.filter((item) => item.label === 'negative' && item.predicted === 'positive');
  const falseNegatives = scored.filter((item) => item.label === 'positive' && item.predicted === 'negative');
  const positives = scored.filter((item) => item.label === 'positive').map((item) => item.score);
  const negatives = scored.filter((item) => item.label === 'negative').map((item) => item.score);
  const report = {
    schemaVersion: 'wp2-reranker-calibration-report.v1',
    generatedAt: new Date().toISOString(),
    provenance: {
      ...candidateSourceProvenance(),
      fixture: FIXTURE_PATH,
      fixtureSha256: fileSha256(FIXTURE_PATH),
      normalizedFixtureSha256: sha256Json(fixture),
    },
    adapter: {
      provider: 'local',
      modelId: MODEL_ID,
      library: '@xenova/transformers',
      libraryVersion: packageVersion(),
      scoreTransform: 'sigmoid(logit)',
      hardTimeoutMs: 10_000,
    },
    selection: {
      rule: 'Accept the configured threshold only when max(negative) < threshold <= min(positive).',
      threshold: THRESHOLD,
      minimumPositiveScore: Math.min(...positives),
      maximumNegativeScore: Math.max(...negatives),
    },
    cases: scored.sort((left, right) => left.id.localeCompare(right.id)),
    confusion: {
      positives: positives.length,
      negatives: negatives.length,
      truePositives: positives.length - falseNegatives.length,
      trueNegatives: negatives.length - falsePositives.length,
      falsePositiveCount: falsePositives.length,
      falseNegativeCount: falseNegatives.length,
      falsePositiveRate: negatives.length === 0 ? 0 : falsePositives.length / negatives.length,
      falseNegativeRate: positives.length === 0 ? 0 : falseNegatives.length / positives.length,
    },
    passed: falsePositives.length === 0 && falseNegatives.length === 0
      && Math.max(...negatives) < THRESHOLD && THRESHOLD <= Math.min(...positives),
    limitations: [
      'Synthetic labeled pairs only; no production query text or production content was used.',
      'This calibration applies only to the recorded local model and adapter version.',
      'Cohere requires its own labeled calibration before enablement; this report does not validate it.',
    ],
  };
  mkdirSync('eval', { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    report: REPORT_PATH,
    threshold: THRESHOLD,
    minimumPositiveScore: report.selection.minimumPositiveScore,
    maximumNegativeScore: report.selection.maximumNegativeScore,
    confusion: report.confusion,
    passed: report.passed,
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

void main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : 'WP-2 reranker calibration failed');
  process.exitCode = 1;
});
