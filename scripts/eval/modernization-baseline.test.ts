import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandEvidenceSchema,
  goldenReportSchema,
  wp0EvidenceSchema,
  type CommandEvidence,
  type RepositoryFingerprints,
  type Wp0CommandName,
  type Wp0Evidence,
} from './capture-wp0-evidence';
import {
  captureModernizationMeasurements,
  measurementEvidenceSchema,
  validateMeasurementEvidence,
  type MeasurementEvidence,
} from './measurement-evidence';
import {
  buildModernizationBaseline,
  snapshotEnvironment,
} from './modernization-baseline';

const CAPTURED_AT = '2026-09-05T01:00:00.000Z';
const REPORT_GENERATED_AT = '2026-09-05T00:00:00.000Z';
const MEASUREMENTS_COLLECTED_AT = '2026-09-05T00:00:01.000Z';
const MEASUREMENT_RUN_ID = '11111111-1111-4111-8111-111111111111';
type FingerprintKey = keyof RepositoryFingerprints;

const HASHES: RepositoryFingerprints = {
  sourceFingerprint: `sha256:${'1'.repeat(64)}`,
  configFingerprint: `sha256:${'2'.repeat(64)}`,
  corpusFingerprint: `sha256:${'3'.repeat(64)}`,
  dirtyTreeFingerprint: `sha256:${'4'.repeat(64)}`,
};
const OTHER_HASH = `sha256:${'9'.repeat(64)}`;
const COMMAND_NAMES: readonly Wp0CommandName[] = [
  'install',
  'pre_change_gate',
  'candidate_gate',
  'mock_eval',
  'real_synthetic_eval',
  'db_check',
];
const PROVENANCE_FIELDS: readonly FingerprintKey[] = [
  'sourceFingerprint',
  'corpusFingerprint',
  'dirtyTreeFingerprint',
];

const temporaryRoots: string[] = [];

interface BaselineFixture {
  readonly rootDirectory: string;
  readonly baselineCommit: string;
  readonly commandEvidence: Wp0Evidence;
}

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function unprefixedSha256File(path: string): string {
  return sha256File(path).slice('sha256:'.length);
}

function runGit(rootDirectory: string, arguments_: readonly string[]): string {
  return execFileSync('git', [...arguments_], {
    cwd: rootDirectory,
    encoding: 'utf8',
  }).trim();
}

function createGitFixture(): { readonly rootDirectory: string; readonly baselineCommit: string } {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'destr-baseline-test-'));
  temporaryRoots.push(rootDirectory);
  mkdirSync(join(rootDirectory, 'eval'), { recursive: true });
  writeFileSync(
    join(rootDirectory, 'package.json'),
    JSON.stringify({
      name: 'baseline-fixture',
      version: '1.0.0',
      packageManager: 'pnpm@10.11.0',
    }, null, 2),
    'utf8',
  );
  writeFileSync(join(rootDirectory, 'README.md'), 'baseline fixture\n', 'utf8');
  runGit(rootDirectory, ['init', '--quiet']);
  runGit(rootDirectory, ['config', 'user.email', 'baseline-fixture@example.test']);
  runGit(rootDirectory, ['config', 'user.name', 'Baseline Fixture']);
  runGit(rootDirectory, ['add', 'package.json', 'README.md']);
  runGit(rootDirectory, ['commit', '--quiet', '-m', 'fixture']);
  return { rootDirectory, baselineCommit: runGit(rootDirectory, ['rev-parse', 'HEAD']) };
}

function report(
  mode: 'mock' | 'real_synthetic',
  baselineCommit: string,
  fingerprints: RepositoryFingerprints = HASHES,
) {
  return goldenReportSchema.parse({
    schemaVersion: 'golden-report.v1',
    mode,
    baselineCommit,
    candidateModelId: 'fixture-model-v1',
    manifestIdentity: 'synthetic-corpus-v2',
    ...fingerprints,
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
    generatedAt: REPORT_GENERATED_AT,
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
}

function writeReports(
  rootDirectory: string,
  baselineCommit: string,
  realFingerprints: RepositoryFingerprints = HASHES,
): void {
  writeFileSync(
    join(rootDirectory, 'eval', 'golden-report.mock.json'),
    `${JSON.stringify(report('mock', baselineCommit), null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(rootDirectory, 'eval', 'golden-report.real-synthetic.json'),
    `${JSON.stringify(report('real_synthetic', baselineCommit, realFingerprints), null, 2)}\n`,
    'utf8',
  );
}

function commandArguments(name: Wp0CommandName): readonly string[] {
  switch (name) {
    case 'install':
      return ['install', '--frozen-lockfile'];
    case 'pre_change_gate':
    case 'candidate_gate':
      return ['gate'];
    case 'mock_eval':
    case 'real_synthetic_eval':
      return ['eval'];
    case 'db_check':
      return ['db:check'];
  }
}

function commandArtifact(
  rootDirectory: string,
  name: Wp0CommandName,
): CommandEvidence['artifactCopy'] {
  const path = name === 'mock_eval'
    ? 'eval/golden-report.mock.json'
    : name === 'real_synthetic_eval'
      ? 'eval/golden-report.real-synthetic.json'
      : null;
  if (path === null) return null;
  const content = readFileSync(join(rootDirectory, path));
  return {
    sourcePath: 'eval/golden-report.json',
    destinationPath: path,
    sha256: sha256Bytes(content),
    byteCount: content.byteLength,
  };
}

function commandRecord(
  rootDirectory: string,
  baselineCommit: string,
  name: Wp0CommandName,
  index: number,
): CommandEvidence {
  const startedAt = `2026-09-05T00:00:${String(index).padStart(2, '0')}.000Z`;
  const completedAt = `2026-09-05T00:00:${String(index).padStart(2, '0')}.500Z`;
  const output = Buffer.from(`fixture command output: ${name}\n`, 'utf8');
  const isRealSynthetic = name === 'real_synthetic_eval';
  const environment = {
    dotenvConfigPath: isRealSynthetic ? 'provided' : 'not_provided',
    evalReal: isRealSynthetic ? '1' : 'not_set',
    evalCorpus: isRealSynthetic ? 'synthetic' : 'not_set',
  };
  return commandEvidenceSchema.parse({
    name,
    argv: ['pnpm', ...commandArguments(name)],
    cwdRole: name === 'pre_change_gate' ? 'base' : 'candidate',
    baselineCommit,
    repository: HASHES,
    environment,
    startedAt,
    completedAt,
    exitCode: 0,
    signal: null,
    status: 'passed',
    failureCode: null,
    stdoutSha256: sha256Bytes(output),
    stderrSha256: sha256Bytes(Buffer.alloc(0)),
    outputSha256: sha256Bytes(output),
    stdoutByteCount: output.byteLength,
    stderrByteCount: 0,
    outputByteCount: output.byteLength,
    artifactCopy: commandArtifact(rootDirectory, name),
  });
}

function evidenceFor(
  rootDirectory: string,
  baselineCommit: string,
  commands: readonly CommandEvidence[] = COMMAND_NAMES.map((name, index) =>
    commandRecord(rootDirectory, baselineCommit, name, index + 1)),
  status: 'passed' | 'failed' = 'passed',
): Wp0Evidence {
  return wp0EvidenceSchema.parse({
    schemaVersion: 'agent-wp0-command-evidence.v1',
    baselineCommit,
    candidateCommit: baselineCommit,
    generatedAt: '2026-09-05T00:00:10.000Z',
    repository: HASHES,
    commands,
    status,
  });
}

function createFixture(realFingerprints: RepositoryFingerprints = HASHES): BaselineFixture {
  const fixture = createGitFixture();
  writeReports(fixture.rootDirectory, fixture.baselineCommit, realFingerprints);
  return {
    ...fixture,
    commandEvidence: evidenceFor(fixture.rootDirectory, fixture.baselineCommit),
  };
}

function baselineInput(
  fixture: BaselineFixture,
  environment: Readonly<Record<string, string | undefined>> = {},
  measurementEvidence?: MeasurementEvidence,
) {
  return {
    capturedAt: CAPTURED_AT,
    rootDirectory: fixture.rootDirectory,
    environment,
    commandEvidence: fixture.commandEvidence,
    ...(measurementEvidence === undefined ? {} : { measurementEvidence }),
  };
}

function replaceCommand(
  evidence: Wp0Evidence,
  name: Wp0CommandName,
  replacement: (command: CommandEvidence) => CommandEvidence,
  status: 'passed' | 'failed' = evidence.status,
): Wp0Evidence {
  return wp0EvidenceSchema.parse({
    ...evidence,
    commands: evidence.commands.map((command) => command.name === name ? replacement(command) : command),
    status,
  });
}

function build(
  fixture: BaselineFixture,
  environment: Readonly<Record<string, string | undefined>> = {},
  measurementEvidence?: MeasurementEvidence,
) {
  return buildModernizationBaseline(baselineInput(fixture, environment, measurementEvidence));
}

afterEach(() => {
  for (const rootDirectory of temporaryRoots.splice(0)) {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

describe('WP-0 modernization baseline consumer', () => {
  it('requires the complete typed evidence set, rejects duplicates, and fails closed on a failed command', () => {
    const fixture = createFixture();
    const missing = {
      ...fixture.commandEvidence,
      commands: fixture.commandEvidence.commands.filter((command) => command.name !== 'db_check'),
    };
    expect(wp0EvidenceSchema.safeParse(missing).success).toBe(false);

    const first = fixture.commandEvidence.commands[0];
    if (first === undefined) throw new Error('fixture command evidence is empty');
    const duplicate = {
      ...fixture.commandEvidence,
      commands: [...fixture.commandEvidence.commands, first],
    };
    expect(wp0EvidenceSchema.safeParse(duplicate).success).toBe(false);

    const failedCommand = replaceCommand(
      fixture.commandEvidence,
      'candidate_gate',
      (command) => ({
        ...command,
        exitCode: 2,
        status: 'failed',
        failureCode: 'nonzero_exit',
      }),
      'failed',
    );
    expect(wp0EvidenceSchema.safeParse(failedCommand).success).toBe(true);
    expect(() => buildModernizationBaseline({
      ...baselineInput(fixture),
      commandEvidence: failedCommand,
    })).toThrow(/failed command/u);
  });

  it('validates named mock and real-synthetic reports and binds their copied artifact hashes', () => {
    const fixture = createFixture();
    const baseline = build(fixture);
    expect(baseline.corpus.mockEvaluation.report).toMatchObject({ status: 'observed' });
    expect(baseline.corpus.realSyntheticEvaluation.report).toMatchObject({ status: 'observed' });
    expect(baseline.corpus.mockEvaluation.reportSha256).toMatchObject({
      status: 'observed',
      value: unprefixedSha256File(join(fixture.rootDirectory, 'eval', 'golden-report.mock.json')),
    });
    expect(baseline.corpus.realSyntheticEvaluation.reportSha256).toMatchObject({
      status: 'observed',
      value: unprefixedSha256File(join(fixture.rootDirectory, 'eval', 'golden-report.real-synthetic.json')),
    });

    const mockCommand = fixture.commandEvidence.commands.find((command) => command.name === 'mock_eval');
    const realCommand = fixture.commandEvidence.commands.find((command) => command.name === 'real_synthetic_eval');
    expect(mockCommand?.artifactCopy?.sha256).toBe(
      sha256File(join(fixture.rootDirectory, 'eval', 'golden-report.mock.json')),
    );
    expect(realCommand?.artifactCopy?.sha256).toBe(
      sha256File(join(fixture.rootDirectory, 'eval', 'golden-report.real-synthetic.json')),
    );

    const tamperedArtifact = {
      ...fixture.commandEvidence,
      commands: fixture.commandEvidence.commands.map((command) => command.name === 'mock_eval'
        ? {
          ...command,
          artifactCopy: command.artifactCopy === null
            ? null
            : { ...command.artifactCopy, sha256: OTHER_HASH },
        }
        : command),
    };
    expect(() => buildModernizationBaseline({
      ...baselineInput(fixture),
      commandEvidence: tamperedArtifact,
    })).toThrow(/SHA-256 does not match/u);
  });

  it.each(PROVENANCE_FIELDS)('rejects %s provenance drift between named reports', (field: FingerprintKey) => {
    const fingerprints: RepositoryFingerprints = { ...HASHES, [field]: OTHER_HASH };
    const fixture = createFixture(fingerprints);
    expect(() => build(fixture)).toThrow(/same source\/corpus state/u);
  });

  it('rejects tampered measurement evidence and a source report changed after collection', () => {
    const fixture = createFixture();
    const measurements = captureModernizationMeasurements({
      rootDirectory: fixture.rootDirectory,
      collectedAt: MEASUREMENTS_COLLECTED_AT,
      runId: MEASUREMENT_RUN_ID,
    });
    expect(measurementEvidenceSchema.safeParse(measurements).success).toBe(true);

    const tampered = measurementEvidenceSchema.parse({
      ...measurements,
      sourceReport: {
        ...measurements.sourceReport,
        sourceFingerprint: OTHER_HASH,
      },
    });
    expect(() => build(fixture, {}, tampered)).toThrow(/sourceReport metadata/u);

    writeFileSync(
      join(fixture.rootDirectory, 'eval', 'golden-report.real-synthetic.json'),
      `${JSON.stringify(report('real_synthetic', fixture.baselineCommit, {
        ...HASHES,
        sourceFingerprint: OTHER_HASH,
      }), null, 2)}\n`,
      'utf8',
    );
    expect(() => validateMeasurementEvidence(fixture.rootDirectory, measurements)).toThrow(/SHA-256/u);
  });

  it('keeps unavailable metrics explicit while accepting provenance-linked phase timing', () => {
    const fixture = createFixture();
    const withoutMeasurements = build(fixture);
    const missingPhaseTiming = withoutMeasurements.measurements.phase_timing;
    const missingDatabaseOperations = withoutMeasurements.measurements.database_operations;
    if (missingPhaseTiming === undefined || missingDatabaseOperations === undefined) {
      throw new Error('baseline did not include required measurement names');
    }
    expect(missingPhaseTiming.status).toBe('not_observable');
    expect(missingDatabaseOperations.status).toBe('not_observable');
    expect('value' in missingDatabaseOperations).toBe(false);

    const measurements = captureModernizationMeasurements({
      rootDirectory: fixture.rootDirectory,
      collectedAt: MEASUREMENTS_COLLECTED_AT,
      runId: MEASUREMENT_RUN_ID,
    });
    const withMeasurements = build(fixture, {}, measurements);
    expect(withMeasurements.measurements.phase_timing).toMatchObject({ status: 'observed' });
    const databaseOperations = withMeasurements.measurements.database_operations;
    if (databaseOperations === undefined) throw new Error('database metric is missing');
    expect(databaseOperations.status).toBe('not_observable');
  });

  it('redacts secrets and provider endpoints from the serialized baseline', () => {
    const fixture = createFixture();
    const environment = {
      CHAT_PROVIDER: 'google',
      GOOGLE_CHAT_MODEL: 'gemini-test',
      CUSTOM_LLM_API_KEY: 'super-secret-api-key',
      CUSTOM_LLM_BASE_URL: 'https://private-provider.example.test/v1',
      DATABASE_URL: 'postgres://private-user:private-password@private-db.example.test/data',
      UPSTASH_REDIS_REST_TOKEN: 'super-secret-redis-token',
      UPSTASH_REDIS_REST_URL: 'https://private-redis.example.test',
    };
    const serialized = JSON.stringify(build(fixture, environment));
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('private-provider');
    expect(serialized).not.toContain('private-db');
    expect(serialized).not.toContain('private-redis');
    expect(snapshotEnvironment(environment).sensitiveConfiguration.CUSTOM_LLM_API_KEY).toBe(true);
  });

  it('is deterministic for fixed repository, configuration, model, and workload inputs', () => {
    const fixture = createFixture();
    const environment = {
      CHAT_PROVIDER: 'google',
      GOOGLE_CHAT_MODEL: 'gemini-test',
      EMBEDDING_PROVIDER: 'google',
    };
    const first = build(fixture, environment);
    const second = build(fixture, environment);
    expect(first.configuration.fingerprintSha256).toEqual(second.configuration.fingerprintSha256);
    expect(first.configuration.environment).toEqual(second.configuration.environment);
    expect(first.modelRoles).toEqual(second.modelRoles);
    expect(first.workloadProfiles).toEqual(second.workloadProfiles);
    expect(first.toolchain.lockfileSha256).toEqual(second.toolchain.lockfileSha256);
  });
});
