import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const GOLDEN_REPORT_SCHEMA_VERSION = 'golden-report.v1';
export const MEASUREMENT_EVIDENCE_SCHEMA_VERSION = 'agent-baseline-measurements.v1';
export const MEASUREMENT_PRODUCER_ID = 'capture-modernization-measurements';
export const MEASUREMENT_PRODUCER_VERSION = '1.0.0';
export const SOURCE_REPORT_PATH = 'eval/golden-report.real-synthetic.json';
export const MEASUREMENT_ARTIFACT_PATH = 'eval/agent-baseline-measurements.json';

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const fileHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonEmptyIdentifierSchema = z.string().trim().min(1).max(200);
const isoDateTimeSchema = z.iso.datetime();

const latencyPercentilesSchema = z
  .strictObject({
    scope: z.literal('all_cases'),
    unit: z.literal('milliseconds'),
    sampleCount: z.number().int().positive(),
    p50: z.number().finite().nonnegative(),
    p95: z.number().finite().nonnegative(),
    p99: z.number().finite().nonnegative(),
  })
  .superRefine((latency, context) => {
    if (latency.p50 > latency.p95) {
      context.addIssue({
        code: 'custom',
        path: ['p95'],
        message: 'p95 must be greater than or equal to p50',
      });
    }
    if (latency.p95 > latency.p99) {
      context.addIssue({
        code: 'custom',
        path: ['p99'],
        message: 'p99 must be greater than or equal to p95',
      });
    }
  });

const modelUsageSchema = z.strictObject({
  scope: z.literal('all_model_calls'),
  unit: z.literal('tokens'),
  sampleCount: z.literal(0),
  status: z.literal('unavailable'),
  inputTokens: z.null(),
  outputTokens: z.null(),
  cacheReadTokens: z.null(),
  cacheWriteTokens: z.null(),
});

/**
 * The real-synthetic report is intentionally parsed at this boundary rather
 * than trusting the TypeScript interface emitted by the eval runner.  This
 * keeps measurement provenance tied to the complete golden-report.v1 shape.
 */
export const realSyntheticGoldenReportSchema = z
  .strictObject({
    schemaVersion: z.literal(GOLDEN_REPORT_SCHEMA_VERSION),
    mode: z.literal('real_synthetic'),
    baselineCommit: commitSchema,
    candidateModelId: nonEmptyIdentifierSchema,
    manifestIdentity: nonEmptyIdentifierSchema,
    sourceFingerprint: fingerprintSchema,
    configFingerprint: fingerprintSchema,
    corpusFingerprint: fingerprintSchema,
    dirtyTreeFingerprint: fingerprintSchema,
    total: z.number().int().positive(),
    hits: z.number().int().nonnegative(),
    passRate: z.number().finite().min(0).max(1),
    docHitGateActive: z.literal(true),
    avgFaithfulness: z.number().finite().min(0).max(1).nullable(),
    avgRetrievalRelevance: z.number().finite().min(0).max(1).nullable(),
    meanFaithfulness: z.number().finite().min(0).max(1),
    meanCorrectness: z.number().finite().min(0).max(1),
    meanContextRelevancy: z.number().finite().min(0).max(1),
    threshold: z.number().finite().positive().max(1),
    passed: z.boolean(),
    generatedAt: isoDateTimeSchema,
    latency: z.strictObject({
      retrievalMs: latencyPercentilesSchema,
      generationMs: latencyPercentilesSchema,
      totalMs: latencyPercentilesSchema,
    }),
    modelUsage: modelUsageSchema,
  })
  .superRefine((report, context) => {
    if (report.hits > report.total) {
      context.addIssue({
        code: 'custom',
        path: ['hits'],
        message: 'hits cannot exceed total',
      });
    }
  });

export type RealSyntheticGoldenReport = z.infer<typeof realSyntheticGoldenReportSchema>;

const phaseTimingScopeSchema = z.enum([
  'retrieval',
  'model_generation',
  'total_turn',
]);
const percentileStatisticSchema = z.enum(['p50', 'p95', 'p99']);

const measurementSampleSchema = z.strictObject({
  runId: z.uuid(),
  metric: z.literal('phase_timing'),
  scope: phaseTimingScopeSchema,
  statistic: percentileStatisticSchema,
  unit: z.literal('milliseconds'),
  value: z.number().finite().nonnegative(),
  sampleCount: z.number().int().positive(),
  capturedAt: isoDateTimeSchema,
  source: z.string().regex(/^eval\/golden-report\.real-synthetic\.json#latency\.(retrievalMs|generationMs|totalMs)\.(p50|p95|p99)$/u),
});

const sourceReportSchema = z.strictObject({
  path: z.literal(SOURCE_REPORT_PATH),
  sha256: fileHashSchema,
  schemaVersion: z.literal(GOLDEN_REPORT_SCHEMA_VERSION),
  mode: z.literal('real_synthetic'),
  baselineCommit: commitSchema,
  generatedAt: isoDateTimeSchema,
  sourceFingerprint: fingerprintSchema,
  configFingerprint: fingerprintSchema,
  corpusFingerprint: fingerprintSchema,
  dirtyTreeFingerprint: fingerprintSchema,
});

const producerSchema = z.strictObject({
  id: z.literal(MEASUREMENT_PRODUCER_ID),
  version: z.literal(MEASUREMENT_PRODUCER_VERSION),
});

export const measurementEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(MEASUREMENT_EVIDENCE_SCHEMA_VERSION),
    runId: z.uuid(),
    producer: producerSchema,
    collectedAt: isoDateTimeSchema,
    baselineCommit: commitSchema,
    sourceReport: sourceReportSchema,
    samples: z.array(measurementSampleSchema).length(9),
  })
  .superRefine((evidence, context) => {
    if (evidence.baselineCommit !== evidence.sourceReport.baselineCommit) {
      context.addIssue({
        code: 'custom',
        path: ['baselineCommit'],
        message: 'baselineCommit must match sourceReport.baselineCommit',
      });
    }

    const collectedAt = Date.parse(evidence.collectedAt);
    const sourceGeneratedAt = Date.parse(evidence.sourceReport.generatedAt);
    if (!Number.isFinite(collectedAt) || !Number.isFinite(sourceGeneratedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['collectedAt'],
        message: 'collection and source timestamps must be valid dates',
      });
    } else if (sourceGeneratedAt > collectedAt) {
      context.addIssue({
        code: 'custom',
        path: ['collectedAt'],
        message: 'collectedAt cannot precede sourceReport.generatedAt',
      });
    }

    const seen = new Set<string>();
    for (const [index, sample] of evidence.samples.entries()) {
      if (sample.runId !== evidence.runId) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index, 'runId'],
          message: 'sample runId must match the evidence runId',
        });
      }

      const key = `${sample.scope}:${sample.statistic}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index],
          message: 'each phase/statistic pair must occur exactly once',
        });
      }
      seen.add(key);

      const capturedAt = Date.parse(sample.capturedAt);
      if (!Number.isFinite(capturedAt) || !Number.isFinite(sourceGeneratedAt)) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index, 'capturedAt'],
          message: 'sample capturedAt must be a valid date',
        });
      } else if (sample.capturedAt !== evidence.sourceReport.generatedAt) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index, 'capturedAt'],
          message: 'sample capturedAt must equal sourceReport.generatedAt',
        });
      } else if (capturedAt > collectedAt) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index, 'capturedAt'],
          message: 'sample capturedAt cannot follow collectedAt',
        });
      }

      const expectedSource = sourceForSample(sample.scope, sample.statistic);
      if (sample.source !== expectedSource) {
        context.addIssue({
          code: 'custom',
          path: ['samples', index, 'source'],
          message: 'sample source does not identify its golden latency field',
        });
      }
    }

    if (seen.size !== 9) {
      context.addIssue({
        code: 'custom',
        path: ['samples'],
        message: 'evidence must contain one p50/p95/p99 sample for each phase',
      });
    }
  });

export type MeasurementSample = z.infer<typeof measurementSampleSchema>;
export type MeasurementEvidence = z.infer<typeof measurementEvidenceSchema>;

type PhaseScope = z.infer<typeof phaseTimingScopeSchema>;
type PercentileStatistic = z.infer<typeof percentileStatisticSchema>;
type LatencyKey = 'retrievalMs' | 'generationMs' | 'totalMs';

const phaseLatencyMap: Readonly<Record<PhaseScope, LatencyKey>> = {
  retrieval: 'retrievalMs',
  model_generation: 'generationMs',
  total_turn: 'totalMs',
};

const phaseScopes: readonly PhaseScope[] = [
  'retrieval',
  'model_generation',
  'total_turn',
];
const percentileStatistics: readonly PercentileStatistic[] = ['p50', 'p95', 'p99'];

function sourceForSample(scope: PhaseScope, statistic: PercentileStatistic): string {
  return `${SOURCE_REPORT_PATH}#latency.${phaseLatencyMap[scope]}.${statistic}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function assertSourceReportMatchesEvidence(
  report: RealSyntheticGoldenReport,
  evidence: MeasurementEvidence,
): void {
  const sourceReport = evidence.sourceReport;
  const expectedSource = {
    path: SOURCE_REPORT_PATH,
    sha256: sourceReport.sha256,
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    baselineCommit: report.baselineCommit,
    generatedAt: report.generatedAt,
    sourceFingerprint: report.sourceFingerprint,
    configFingerprint: report.configFingerprint,
    corpusFingerprint: report.corpusFingerprint,
    dirtyTreeFingerprint: report.dirtyTreeFingerprint,
  } satisfies typeof sourceReport;
  if (JSON.stringify(expectedSource) !== JSON.stringify(sourceReport)) {
    throw new Error('measurement sourceReport metadata does not match the golden report');
  }

  const expectedSamples = buildSamples({
    report,
    runId: evidence.runId,
  });
  if (JSON.stringify(expectedSamples) !== JSON.stringify(evidence.samples)) {
    throw new Error('measurement samples do not match the golden report latency fields');
  }
}

function buildSamples(input: {
  readonly report: RealSyntheticGoldenReport;
  readonly runId: string;
}): readonly MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  for (const scope of phaseScopes) {
    const latency = input.report.latency[phaseLatencyMap[scope]];
    for (const statistic of percentileStatistics) {
      samples.push({
        runId: input.runId,
        metric: 'phase_timing',
        scope,
        statistic,
        unit: 'milliseconds',
        value: latency[statistic],
        sampleCount: latency.sampleCount,
        capturedAt: input.report.generatedAt,
        source: sourceForSample(scope, statistic),
      });
    }
  }
  return samples;
}

function buildEvidenceFromReport(input: {
  readonly report: RealSyntheticGoldenReport;
  readonly sourceReportHash: string;
  readonly collectedAt: string;
  readonly runId: string;
}): MeasurementEvidence {
  const evidence = {
    schemaVersion: MEASUREMENT_EVIDENCE_SCHEMA_VERSION,
    runId: input.runId,
    producer: {
      id: MEASUREMENT_PRODUCER_ID,
      version: MEASUREMENT_PRODUCER_VERSION,
    },
    collectedAt: input.collectedAt,
    baselineCommit: input.report.baselineCommit,
    sourceReport: {
      path: SOURCE_REPORT_PATH,
      sha256: input.sourceReportHash,
      schemaVersion: input.report.schemaVersion,
      mode: input.report.mode,
      baselineCommit: input.report.baselineCommit,
      generatedAt: input.report.generatedAt,
      sourceFingerprint: input.report.sourceFingerprint,
      configFingerprint: input.report.configFingerprint,
      corpusFingerprint: input.report.corpusFingerprint,
      dirtyTreeFingerprint: input.report.dirtyTreeFingerprint,
    },
    samples: [...buildSamples({
      report: input.report,
      runId: input.runId,
    })],
  } satisfies z.input<typeof measurementEvidenceSchema>;
  return measurementEvidenceSchema.parse(evidence);
}

export interface MeasurementCaptureInput {
  readonly rootDirectory: string;
  readonly collectedAt?: string;
  readonly runId?: string;
}

/** Read, validate, hash, and convert the real-synthetic report into evidence. */
export function captureModernizationMeasurements(
  input: MeasurementCaptureInput,
): MeasurementEvidence {
  const rootDirectory = resolve(input.rootDirectory);
  const sourcePath = join(rootDirectory, SOURCE_REPORT_PATH);
  if (!existsSync(sourcePath)) {
    throw new Error(`real-synthetic golden report is missing: ${SOURCE_REPORT_PATH}`);
  }

  const sourceBytes = readFileSync(sourcePath);
  const report = realSyntheticGoldenReportSchema.parse(parseJson(sourceBytes.toString('utf8')));
  const collectedAt = isoDateTimeSchema.parse(input.collectedAt ?? new Date().toISOString());
  const runId = z.uuid().parse(input.runId ?? randomUUID());
  const evidence = buildEvidenceFromReport({
    report,
    sourceReportHash: sha256(sourceBytes),
    collectedAt,
    runId,
  });
  assertSourceReportMatchesEvidence(report, evidence);
  return evidence;
}

/**
 * Re-read the source report and verify an existing artifact has not been
 * detached from the report that produced it.  This is used by the baseline
 * consumer as well as by the CLI tests.
 */
export function validateMeasurementEvidence(
  rootDirectory: string,
  input: unknown,
): MeasurementEvidence {
  const evidence = measurementEvidenceSchema.parse(input);
  const expectedRoot = resolve(rootDirectory);
  const sourcePath = join(expectedRoot, SOURCE_REPORT_PATH);
  const sourceBytes = readFileSync(sourcePath);
  const actualHash = sha256(sourceBytes);
  if (actualHash !== evidence.sourceReport.sha256) {
    throw new Error('measurement source report SHA-256 does not match the artifact');
  }
  const report = realSyntheticGoldenReportSchema.parse(parseJson(sourceBytes.toString('utf8')));
  if (report.baselineCommit !== evidence.baselineCommit) {
    throw new Error('measurement baselineCommit does not match the source report');
  }
  assertSourceReportMatchesEvidence(report, evidence);
  return evidence;
}

export function writeModernizationMeasurements(
  input: MeasurementCaptureInput,
): string {
  const rootDirectory = resolve(input.rootDirectory);
  const evidence = captureModernizationMeasurements(input);
  const outputPath = join(rootDirectory, MEASUREMENT_ARTIFACT_PATH);
  mkdirSync(join(rootDirectory, 'eval'), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return outputPath;
}
