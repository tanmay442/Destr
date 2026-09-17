import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import { goldenQuestions } from './golden';
import {
  buildGoldenReport,
  evalGateFailure,
  fingerprint,
  mockEvalDeps,
  runEval,
} from './harness';
import { SYNTHETIC_MOCK_CORPUS_VERSION } from './mock-corpus';

loadDotEnv();

const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'retrieval-report.json');

function gitCommit(): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return out.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const thresholdRaw = process.env.EVAL_FAITHFULNESS_THRESHOLD ?? '0.7';
  const threshold = Number(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`[eval:retrieval] invalid threshold ${thresholdRaw}; failing closed`);
    process.exit(1);
  }
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || gitCommit();
  const report = await runEval(goldenQuestions, mockEvalDeps(), threshold, 'mock');
  const goldenReport = buildGoldenReport(report, {
    mode: 'mock',
    baselineCommit: commit,
    candidateModelId: 'synthetic-mock-model',
    manifestIdentity: SYNTHETIC_MOCK_CORPUS_VERSION,
    sourceFingerprint: fingerprint(['source.v1', `commit=${commit}`]),
    configFingerprint: fingerprint([
      'config.v1',
      'retrieval-only',
      `threshold=${threshold}`,
    ]),
    corpusFingerprint: fingerprint([SYNTHETIC_MOCK_CORPUS_VERSION]),
    dirtyTreeFingerprint: fingerprint(['dirty-tree.v1', 'retrieval-run']),
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(goldenReport, null, 2)}\n`);
  console.log(`retrieval report written to ${REPORT_PATH}`);
  console.log(`mode=mock questions=${report.results.length} hits=${report.hits} passRate=${(report.passRate * 100).toFixed(0)}% docHitGateActive=${goldenReport.docHitGateActive}`);
  if (!goldenReport.docHitGateActive) {
    console.error('[eval:retrieval] doc-hit gate INACTIVE: retrieval gate is vacuous; failing closed');
    process.exit(1);
  }
  const failure = evalGateFailure(report);
  if (failure !== null) {
    console.error(`[eval:retrieval] gate failure: ${failure}`);
    process.exit(1);
  }
  if (!report.passed) {
    console.error(`[eval:retrieval] mean faithfulness ${report.meanFaithfulness.toFixed(2)} < threshold ${threshold}`);
    process.exit(1);
  }
  console.log('OVERALL: PASS');
}

main().catch((error: unknown) => {
  console.error('[eval:retrieval] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
