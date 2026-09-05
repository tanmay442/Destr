import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureModernizationMeasurements,
  MEASUREMENT_ARTIFACT_PATH,
  measurementEvidenceSchema,
  MEASUREMENT_EVIDENCE_SCHEMA_VERSION,
  MEASUREMENT_PRODUCER_ID,
  MEASUREMENT_PRODUCER_VERSION,
  realSyntheticGoldenReportSchema,
  SOURCE_REPORT_PATH,
  validateMeasurementEvidence,
  writeModernizationMeasurements,
} from './measurement-evidence';

const BASELINE_COMMIT = 'e22b95119bceba09be0c5b4e0089920b1dc623f2';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const GENERATED_AT = '2026-09-05T00:00:00.000Z';
const COLLECTED_AT = '2026-09-05T00:00:01.000Z';

const reportFixture = realSyntheticGoldenReportSchema.parse({
  schemaVersion: 'golden-report.v1',
  mode: 'real_synthetic',
  baselineCommit: BASELINE_COMMIT,
  candidateModelId: 'fixture-model-v1',
  manifestIdentity: 'synthetic-mock-corpus.v2',
  sourceFingerprint: `sha256:${'1'.repeat(64)}`,
  configFingerprint: `sha256:${'2'.repeat(64)}`,
  corpusFingerprint: `sha256:${'3'.repeat(64)}`,
  dirtyTreeFingerprint: `sha256:${'4'.repeat(64)}`,
  total: 35,
  hits: 27,
  passRate: 1,
  docHitGateActive: true,
  avgFaithfulness: 1,
  avgRetrievalRelevance: 0.9,
  meanFaithfulness: 1,
  meanCorrectness: 0.95,
  meanContextRelevancy: 0.9,
  threshold: 0.7,
  passed: true,
  generatedAt: GENERATED_AT,
  latency: {
    retrievalMs: {
      scope: 'all_cases',
      unit: 'milliseconds',
      sampleCount: 35,
      p50: 10,
      p95: 20,
      p99: 30,
    },
    generationMs: {
      scope: 'all_cases',
      unit: 'milliseconds',
      sampleCount: 35,
      p50: 40,
      p95: 50,
      p99: 60,
    },
    totalMs: {
      scope: 'all_cases',
      unit: 'milliseconds',
      sampleCount: 35,
      p50: 55,
      p95: 75,
      p99: 90,
    },
  },
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
});

const temporaryRoots: string[] = [];

function createFixtureRoot(): string {
  const root = join(tmpdir(), `destr-measurements-${Date.now()}-${temporaryRoots.length}`);
  mkdirSync(join(root, 'eval'), { recursive: true });
  writeFileSync(
    join(root, SOURCE_REPORT_PATH),
    `${JSON.stringify(reportFixture, null, 2)}\n`,
    'utf8',
  );
  temporaryRoots.push(root);
  return root;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function artifactText(root: string): string {
  return readFileSync(join(root, MEASUREMENT_ARTIFACT_PATH), 'utf8');
}

function replaceOnce(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`fixture text did not contain ${needle}`);
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

function replaceNth(text: string, needle: string, replacement: string, occurrence: number): string {
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(needle, offset);
    if (found < 0) throw new Error(`fixture text did not contain occurrence ${occurrence} of ${needle}`);
    if (index === occurrence) {
      return `${text.slice(0, found)}${replacement}${text.slice(found + needle.length)}`;
    }
    offset = found + needle.length;
  }
  throw new Error('unreachable replacement branch');
}

function writeArtifact(root: string, text: string): unknown {
  writeFileSync(join(root, MEASUREMENT_ARTIFACT_PATH), text, 'utf8');
  return parseJson(text);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('real-synthetic modernization measurement producer', () => {
  it('accepts a pass rate whose denominator is labeled document-hit cases', () => {
    const parsed = realSyntheticGoldenReportSchema.parse(reportFixture);
    expect(parsed.total).toBe(35);
    expect(parsed.hits).toBe(27);
    expect(parsed.passRate).toBe(1);
  });

  it('creates nine provenance-linked phase percentile samples from the report', () => {
    const root = createFixtureRoot();
    const evidence = captureModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });

    expect(evidence.schemaVersion).toBe(MEASUREMENT_EVIDENCE_SCHEMA_VERSION);
    expect(evidence.runId).toBe(RUN_ID);
    expect(evidence.producer).toEqual({
      id: MEASUREMENT_PRODUCER_ID,
      version: MEASUREMENT_PRODUCER_VERSION,
    });
    expect(evidence.sourceReport.path).toBe(SOURCE_REPORT_PATH);
    expect(evidence.sourceReport.sha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(root, SOURCE_REPORT_PATH)))
        .digest('hex'),
    );
    expect(evidence.samples).toHaveLength(9);
    expect(evidence.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: RUN_ID,
        metric: 'phase_timing',
        scope: 'retrieval',
        statistic: 'p95',
        unit: 'milliseconds',
        value: 20,
        sampleCount: 35,
        capturedAt: GENERATED_AT,
        source: `${SOURCE_REPORT_PATH}#latency.retrievalMs.p95`,
      }),
      expect.objectContaining({
        runId: RUN_ID,
        metric: 'phase_timing',
        scope: 'model_generation',
        statistic: 'p99',
        unit: 'milliseconds',
        value: 60,
        sampleCount: 35,
        capturedAt: GENERATED_AT,
        source: `${SOURCE_REPORT_PATH}#latency.generationMs.p99`,
      }),
      expect.objectContaining({
        runId: RUN_ID,
        metric: 'phase_timing',
        scope: 'total_turn',
        statistic: 'p50',
        unit: 'milliseconds',
        value: 55,
        sampleCount: 35,
        capturedAt: GENERATED_AT,
        source: `${SOURCE_REPORT_PATH}#latency.totalMs.p50`,
      }),
    ]));

    expect(() => measurementEvidenceSchema.parse(evidence)).not.toThrow();
    expect(() => validateMeasurementEvidence(root, evidence)).not.toThrow();
  });

  it('writes only when the CLI-facing writer is invoked', () => {
    const root = createFixtureRoot();
    expect(existsSync(join(root, MEASUREMENT_ARTIFACT_PATH))).toBe(false);
    const outputPath = writeModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });
    expect(outputPath).toBe(join(root, MEASUREMENT_ARTIFACT_PATH));
    expect(measurementEvidenceSchema.parse(parseJson(artifactText(root))).samples).toHaveLength(9);
  });

  it('rejects an artifact with a tampered source hash', () => {
    const root = createFixtureRoot();
    const evidence = captureModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });
    const tampered = replaceOnce(
      JSON.stringify(evidence),
      `"sha256":"${evidence.sourceReport.sha256}"`,
      `"sha256":"${'0'.repeat(64)}"`,
    );
    expect(() => validateMeasurementEvidence(root, writeArtifact(root, tampered))).toThrow(/SHA-256/u);
  });

  it('rejects a source file changed after evidence capture', () => {
    const root = createFixtureRoot();
    const evidence = captureModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });
    writeFileSync(
      join(root, SOURCE_REPORT_PATH),
      `${JSON.stringify({ ...reportFixture, candidateModelId: 'changed-fixture-model' }, null, 2)}\n`,
      'utf8',
    );
    expect(() => validateMeasurementEvidence(root, evidence)).toThrow(/SHA-256/u);
  });

  it('rejects mismatched commit, mode, timestamps, run IDs, and units', () => {
    const root = createFixtureRoot();
    const evidence = captureModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });
    const evidenceText = JSON.stringify(evidence);

    const mismatchedCommit = replaceOnce(
      evidenceText,
      `"baselineCommit":"${BASELINE_COMMIT}"`,
      `"baselineCommit":"${'f'.repeat(40)}"`,
    );
    expect(() => measurementEvidenceSchema.parse(parseJson(mismatchedCommit))).toThrow(/baselineCommit/u);

    const mismatchedMode = replaceOnce(
      evidenceText,
      '"mode":"real_synthetic"',
      '"mode":"mock"',
    );
    expect(() => measurementEvidenceSchema.parse(parseJson(mismatchedMode))).toThrow(/real_synthetic/u);

    const mismatchedTimestamp = replaceOnce(
      evidenceText,
      `"capturedAt":"${GENERATED_AT}"`,
      '"capturedAt":"2026-09-05T00:00:00.001Z"',
    );
    expect(() => measurementEvidenceSchema.parse(parseJson(mismatchedTimestamp))).toThrow(/capturedAt/u);

    const mismatchedRunId = replaceNth(
      evidenceText,
      `"runId":"${RUN_ID}"`,
      '"runId":"22222222-2222-4222-8222-222222222222"',
      1,
    );
    expect(() => measurementEvidenceSchema.parse(parseJson(mismatchedRunId))).toThrow(/runId/u);

    const mismatchedUnit = replaceOnce(
      evidenceText,
      '"unit":"milliseconds"',
      '"unit":"seconds"',
    );
    expect(() => measurementEvidenceSchema.parse(parseJson(mismatchedUnit))).toThrow(/milliseconds/u);
  });

  it('rejects latency values that are detached from the source report', () => {
    const root = createFixtureRoot();
    const evidence = captureModernizationMeasurements({
      rootDirectory: root,
      collectedAt: COLLECTED_AT,
      runId: RUN_ID,
    });
    const tampered = replaceOnce(
      JSON.stringify(evidence),
      '"value":20',
      '"value":21',
    );
    const parsed = measurementEvidenceSchema.parse(writeArtifact(root, tampered));
    expect(() => validateMeasurementEvidence(root, parsed)).toThrow(/latency fields/u);
  });
});
