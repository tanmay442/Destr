import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import {
  goldenReportSchema,
  wp0EvidenceSchema,
  type Wp0Evidence,
} from './capture-wp0-evidence';
import {
  measurementEvidenceSchema,
  validateMeasurementEvidence,
  type MeasurementEvidence,
} from './measurement-evidence';
import { workloadProfiles } from './workload-profile';

export { measurementEvidenceSchema } from './measurement-evidence';
export type { CommandEvidence } from './capture-wp0-evidence';

export type Observation<T> =
  | { readonly status: 'observed'; readonly value: T; readonly source: string }
  | { readonly status: 'unverified'; readonly reason: string; readonly source: string }
  | { readonly status: 'not_observable'; readonly reason: string };

export interface EnvironmentSnapshot {
  readonly identifiers: Readonly<Record<string, string | 'absent' | 'redacted'>>;
  readonly identifierSources: Readonly<Record<string, 'environment_override' | 'not_configured'>>;
  readonly sensitiveConfiguration: Readonly<Record<string, boolean>>;
}

export const measurementNameSchema = z.enum([
  'phase_timing',
  'database_operations',
  'redis_operations',
  'database_pool_wait',
  'per_step_prompt_cache',
  'sse_events_bytes',
  'background_judge_volume',
  'main_model_cost',
  'planner_cost',
  'embedding_cost',
  'reranker_cost',
  'verification_cost',
  'vercel_cost',
  'database_cost',
  'redis_cost',
  'egress_cost',
]);

export interface BaselineBuildInput {
  readonly capturedAt: string;
  readonly rootDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly commandEvidence: Wp0Evidence;
  readonly measurementEvidence?: MeasurementEvidence;
}

const SAFE_IDENTIFIER_KEYS = [
  'CHAT_PROVIDER',
  'EMBEDDING_PROVIDER',
  'RERANKER_PROVIDER',
  'LLM_MODEL',
  'AUX_MODEL',
  'GOOGLE_CHAT_MODEL',
  'GOOGLE_EMBEDDING_MODEL',
  'OPENAI_EMBEDDING_MODEL',
  'OLLAMA_CHAT_MODEL',
  'OLLAMA_EMBEDDING_MODEL',
  'COHERE_RERANK_MODEL',
  'LOCAL_RERANK_MODEL',
] as const;

const SENSITIVE_CONFIGURATION_KEYS = [
  'AI_STUDIO_KEY',
  'COHERE_API_KEY',
  'CUSTOM_LLM_API_KEY',
  'CUSTOM_LLM_BASE_URL',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'OLLAMA_BASE_URL',
  'OPENAI_EMBEDDING_API_KEY',
  'OPENAI_EMBEDDING_BASE_URL',
  'QSTASH_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'VERCEL_OIDC_TOKEN',
] as const;

const FINGERPRINT_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.env.example',
  'config/app.config.ts',
  'packages/domain/src/constants.ts',
  'packages/infrastructure/src/config/database.ts',
  'packages/infrastructure/src/config/env.ts',
  'drizzle/meta/_journal.json',
  'scripts/eval/golden.ts',
  'scripts/eval/agent-baseline-cases.ts',
  'scripts/eval/workload-profile.ts',
] as const;

const REQUIRED_MEASUREMENTS = measurementNameSchema.options;

function observed<T>(value: T, source: string): Observation<T> {
  return { status: 'observed', value, source };
}

function unverified<T>(reason: string, source: string): Observation<T> {
  return { status: 'unverified', reason, source };
}

function notObservable<T>(reason: string): Observation<T> {
  return { status: 'not_observable', reason };
}

function safeIdentifier(value: string | undefined): string | 'absent' | 'redacted' {
  if (value === undefined || value.trim() === '') return 'absent';
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(value) ? value : 'redacted';
}

export function snapshotEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentSnapshot {
  const identifiers: Record<string, string | 'absent' | 'redacted'> = {};
  const identifierSources: Record<string, 'environment_override' | 'not_configured'> = {};
  for (const key of SAFE_IDENTIFIER_KEYS) {
    const value = environment[key];
    identifiers[key] = safeIdentifier(value);
    identifierSources[key] = value?.trim() ? 'environment_override' : 'not_configured';
  }
  const sensitiveConfiguration: Record<string, boolean> = {};
  for (const key of SENSITIVE_CONFIGURATION_KEYS) {
    sensitiveConfiguration[key] = Boolean(environment[key]?.trim());
  }
  return { identifiers, identifierSources, sensitiveConfiguration };
}

function command(
  rootDirectory: string,
  executable: string,
  arguments_: readonly string[],
): Observation<string> {
  try {
    return observed(
      execFileSync(executable, arguments_, {
        cwd: rootDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      `${executable} ${arguments_.join(' ')}`,
    );
  } catch {
    return unverified('read-only command failed', `${executable} ${arguments_.join(' ')}`);
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function fingerprint(rootDirectory: string, path: string): Observation<string> {
  const absolutePath = join(rootDirectory, path);
  if (!existsSync(absolutePath)) return unverified('source file missing', path);
  try {
    return observed(sha256(readFileSync(absolutePath)), path);
  } catch {
    return unverified('source file unreadable', path);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> | null {
  const parsed = readJson(path);
  return typeof parsed === 'object' && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : null;
}

function stringProperty(object: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = object?.[key];
  return typeof value === 'string' ? value : null;
}

function dependencyVersion(
  manifest: Readonly<Record<string, unknown>> | null,
  dependency: string,
): Observation<string> {
  const dependencies = manifest?.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null) {
    return unverified('dependencies missing', 'package.json');
  }
  const value = Reflect.get(dependencies, dependency);
  return typeof value === 'string'
    ? observed(value.replace(/^\^/u, ''), `package.json dependencies.${dependency}`)
    : unverified('dependency missing', `package.json dependencies.${dependency}`);
}

function sourceNumber(
  rootDirectory: string,
  path: string,
  expression: RegExp,
  multiplier = 1,
): Observation<number> {
  try {
    const token = expression.exec(readFileSync(join(rootDirectory, path), 'utf8'))?.[1];
    if (token === undefined) return unverified('source field not found', path);
    const value = Number(token.replace(/_/gu, '')) * multiplier;
    return Number.isFinite(value)
      ? observed(value, path)
      : unverified('source field invalid', path);
  } catch {
    return unverified('source file unreadable', path);
  }
}

function vercelLink(rootDirectory: string) {
  const project = readJsonObject(join(rootDirectory, '.vercel', 'project.json'));
  const projectName = stringProperty(project, 'projectName');
  return {
    projectName: projectName
      ? observed(safeIdentifier(projectName), '.vercel/project.json')
      : unverified<string>('local project link unavailable', '.vercel/project.json'),
    projectIdConfigured: stringProperty(project, 'projectId') !== null,
    orgIdConfigured: stringProperty(project, 'orgId') !== null,
  };
}

function observationValue(observation: Observation<string>): string | null {
  return observation.status === 'observed' ? observation.value : null;
}

function resolvedIdentifier(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string | undefined,
  fallbackSource: string,
): Observation<string> {
  const configured = environment[key]?.trim();
  if (configured) return observed(safeIdentifier(configured), `${key} environment override`);
  if (fallback) return observed(safeIdentifier(fallback), fallbackSource);
  return unverified(`effective ${key} is required but unavailable`, `${key} resolution`);
}

function providerObservation(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string,
  allowed: readonly string[],
): Observation<string> {
  const candidate = environment[key]?.trim() || fallback;
  return allowed.includes(candidate)
    ? observed(candidate, environment[key]?.trim() ? `${key} environment override` : `${key} code default`)
    : unverified(`unsupported ${key} value`, `${key} resolution`);
}

function chatModel(
  environment: Readonly<Record<string, string | undefined>>,
  provider: Observation<string>,
): Observation<string> {
  const name = observationValue(provider);
  if (name === 'google') {
    return resolvedIdentifier(environment, 'GOOGLE_CHAT_MODEL', 'gemini-2.5-flash', 'google chat adapter default');
  }
  if (name === 'ollama') {
    return resolvedIdentifier(environment, 'OLLAMA_CHAT_MODEL', 'gemma4:e2b', 'ollama chat adapter default');
  }
  if (name === 'openai') {
    return resolvedIdentifier(environment, 'LLM_MODEL', undefined, 'openai chat adapter requirement');
  }
  return unverified('chat provider unavailable', 'CHAT_PROVIDER resolution');
}

function effectiveModelRoles(environment: Readonly<Record<string, string | undefined>>) {
  const chatProvider = providerObservation(environment, 'CHAT_PROVIDER', 'openai', [
    'openai',
    'google',
    'ollama',
  ]);
  const mainModel = chatModel(environment, chatProvider);
  const auxModel = environment.AUX_MODEL?.trim()
    ? resolvedIdentifier(environment, 'AUX_MODEL', undefined, 'AUX_MODEL resolution')
    : mainModel.status === 'observed'
      ? observed(mainModel.value, 'main model fallback because AUX_MODEL is not configured')
      : unverified<string>('main and auxiliary model identifiers unavailable', 'AUX_MODEL resolution');
  const embeddingProvider = providerObservation(environment, 'EMBEDDING_PROVIDER', 'google', [
    'google',
    'openai',
    'ollama',
  ]);
  const embeddingProviderName = observationValue(embeddingProvider);
  const embeddingModel = embeddingProviderName === 'google'
    ? resolvedIdentifier(environment, 'GOOGLE_EMBEDDING_MODEL', 'gemini-embedding-001', 'google embedding adapter default')
    : embeddingProviderName === 'openai'
      ? resolvedIdentifier(environment, 'OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small', 'openai embedding adapter default')
      : embeddingProviderName === 'ollama'
        ? resolvedIdentifier(environment, 'OLLAMA_EMBEDDING_MODEL', 'embeddinggemma:latest', 'ollama embedding adapter default')
        : unverified<string>('embedding provider unavailable', 'EMBEDDING_PROVIDER resolution');
  const rerankerProvider = providerObservation(environment, 'RERANKER_PROVIDER', 'cosine', [
    'cosine',
    'local',
    'cohere',
  ]);
  const rerankerProviderName = observationValue(rerankerProvider);
  const rerankerModel = rerankerProviderName === 'cosine'
    ? observed('cosine-similarity', 'cosine reranker has no external model')
    : rerankerProviderName === 'local'
      ? resolvedIdentifier(environment, 'LOCAL_RERANK_MODEL', 'Xenova/ms-marco-MiniLM-L-6-v2', 'local reranker adapter default')
      : rerankerProviderName === 'cohere'
        ? resolvedIdentifier(environment, 'COHERE_RERANK_MODEL', 'rerank-english-v3.0', 'Cohere reranker adapter default')
        : unverified<string>('reranker provider unavailable', 'RERANKER_PROVIDER resolution');

  const quota = () => ({
    rpm: notObservable<number>('provider quota not configured in repository'),
    tpm: notObservable<number>('provider quota not configured in repository'),
    concurrency: notObservable<number>('provider quota not configured in repository'),
    contextTokens: notObservable<number>('provider quota not configured in repository'),
    outputTokens: notObservable<number>('provider quota not configured in repository'),
  });
  return [
    { role: 'main', provider: chatProvider, model: mainModel, providerQuota: quota() },
    { role: 'planner', provider: chatProvider, model: auxModel, providerQuota: quota() },
    { role: 'rewrite', provider: chatProvider, model: auxModel, providerQuota: quota() },
    { role: 'grader', provider: chatProvider, model: auxModel, providerQuota: quota() },
    { role: 'judge', provider: chatProvider, model: auxModel, providerQuota: quota() },
    { role: 'embedding', provider: embeddingProvider, model: embeddingModel, providerQuota: quota() },
    { role: 'reranker', provider: rerankerProvider, model: rerankerModel, providerQuota: quota() },
  ] as const;
}

function evalSnapshot(
  rootDirectory: string,
  capturedAt: string,
  baselineCommit: Observation<string>,
  reportPath: 'eval/golden-report.mock.json' | 'eval/golden-report.real-synthetic.json',
  expectedMode: 'mock' | 'real_synthetic',
) {
  const absoluteReportPath = join(rootDirectory, reportPath);
  const parsed = goldenReportSchema.safeParse(readJson(absoluteReportPath));
  const fingerprintObservation = existsSync(absoluteReportPath)
    ? fingerprint(rootDirectory, reportPath)
    : unverified<string>(`${expectedMode} eval report unavailable`, reportPath);
  if (!parsed.success) {
    return {
      report: unverified<z.infer<typeof goldenReportSchema>>(
        `${expectedMode} eval report is missing or fails golden-report.v1 validation`,
        reportPath,
      ),
      reportSha256: fingerprintObservation,
    };
  }
  const report = parsed.data;
  const commit = observationValue(baselineCommit);
  const ageMs = Date.parse(capturedAt) - Date.parse(report.generatedAt);
  const invalidReason = report.mode !== expectedMode
    ? `expected a ${expectedMode} eval report`
    : commit === null || report.baselineCommit !== commit
      ? 'eval report baseline commit does not match current commit'
      : !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1_000
        ? 'eval report is stale or newer than the baseline capture'
        : !report.docHitGateActive
          ? 'eval report document-hit gate is inactive'
          : !report.passed
            ? 'eval report did not pass'
            : expectedMode === 'real_synthetic' && report.candidateModelId === 'synthetic-mock-model'
              ? 'real-synthetic report does not identify a real candidate model'
            : null;
  return {
    report: invalidReason
      ? unverified<z.infer<typeof goldenReportSchema>>(invalidReason, reportPath)
      : observed(report, `validated ${reportPath}`),
    reportSha256: fingerprintObservation,
  };
}

function measurementsSnapshot(
  rootDirectory: string,
  capturedAt: string,
  measurementEvidence: MeasurementEvidence | undefined,
  baselineCommit: Observation<string>,
  realEvaluation: ReturnType<typeof evalSnapshot>,
): Readonly<Record<string, Observation<MeasurementEvidence['samples']>>> {
  const commit = observationValue(baselineCommit);
  let validatedEvidence: MeasurementEvidence | undefined;
  if (measurementEvidence !== undefined) {
    validatedEvidence = validateMeasurementEvidence(rootDirectory, measurementEvidence);
    if (validatedEvidence.baselineCommit !== commit) {
      throw new Error('Measurement evidence baseline commit does not match the current commit');
    }
    if (Date.parse(validatedEvidence.collectedAt) > Date.parse(capturedAt)) {
      throw new Error('Measurement evidence was collected after the baseline capture');
    }
    if (realEvaluation.report.status !== 'observed') {
      throw new Error('Measurement evidence requires a validated real-synthetic report');
    }
    const report = realEvaluation.report.value;
    const source = validatedEvidence.sourceReport;
    if (
      source.sourceFingerprint !== report.sourceFingerprint
      || source.configFingerprint !== report.configFingerprint
      || source.corpusFingerprint !== report.corpusFingerprint
      || source.dirtyTreeFingerprint !== report.dirtyTreeFingerprint
    ) {
      throw new Error('Measurement evidence provenance does not match the real-synthetic report');
    }
  }
  return Object.fromEntries(REQUIRED_MEASUREMENTS.map((name) => {
    const samples = name === 'phase_timing' ? validatedEvidence?.samples ?? [] : [];
    return [
      name,
      samples.length > 0
        ? observed(samples, 'validated agent-baseline-measurements.v1 input')
        : notObservable<MeasurementEvidence['samples']>(
            'no validated pre-change measurement evidence supplied at the required scope',
          ),
    ];
  }));
}

export function buildModernizationBaseline(input: BaselineBuildInput) {
  const capturedAt = z.iso.datetime().parse(input.capturedAt);
  const commandEvidence = wp0EvidenceSchema.parse(input.commandEvidence);
  const measurementEvidence = input.measurementEvidence === undefined
    ? undefined
    : measurementEvidenceSchema.parse(input.measurementEvidence);
  const rootDirectory = resolve(input.rootDirectory);
  const manifest = readJsonObject(join(rootDirectory, 'package.json'));
  const environment = snapshotEnvironment(input.environment);
  const packageManager = stringProperty(manifest, 'packageManager');
  const commit = command(rootDirectory, 'git', ['rev-parse', 'HEAD']);
  const mockEvaluation = evalSnapshot(
    rootDirectory,
    capturedAt,
    commit,
    'eval/golden-report.mock.json',
    'mock',
  );
  const realSyntheticEvaluation = evalSnapshot(
    rootDirectory,
    capturedAt,
    commit,
    'eval/golden-report.real-synthetic.json',
    'real_synthetic',
  );
  const currentCommit = observationValue(commit);
  if (commandEvidence.baselineCommit !== currentCommit || commandEvidence.candidateCommit !== currentCommit) {
    throw new Error('Command evidence commit does not match the current baseline commit');
  }
  if (commandEvidence.status !== 'passed') {
    throw new Error('WP-0 command evidence contains a failed command');
  }
  const evidenceAgeMs = Date.parse(capturedAt) - Date.parse(commandEvidence.generatedAt);
  if (!Number.isFinite(evidenceAgeMs) || evidenceAgeMs < 0 || evidenceAgeMs > 24 * 60 * 60 * 1_000) {
    throw new Error('WP-0 command evidence is stale or newer than the baseline capture');
  }
  for (const [name, evaluation] of [
    ['mock_eval', mockEvaluation],
    ['real_synthetic_eval', realSyntheticEvaluation],
  ] as const) {
    const record = commandEvidence.commands.find((candidate) => candidate.name === name);
    if (record?.status === 'passed' && evaluation.report.status !== 'observed') {
      throw new Error(`${name} is marked passed but its report is unverified: ${evaluation.report.reason}`);
    }
    if (record?.artifactCopy === null || record?.artifactCopy === undefined) {
      throw new Error(`${name} is missing copied-report evidence`);
    }
    const reportSha = evaluation.reportSha256;
    if (reportSha.status !== 'observed' || `sha256:${reportSha.value}` !== record.artifactCopy.sha256) {
      throw new Error(`${name} copied-report SHA-256 does not match the validated report`);
    }
  }
  if (
    mockEvaluation.report.status === 'observed'
    && realSyntheticEvaluation.report.status === 'observed'
    && (
      mockEvaluation.report.value.sourceFingerprint !== realSyntheticEvaluation.report.value.sourceFingerprint
      || mockEvaluation.report.value.corpusFingerprint !== realSyntheticEvaluation.report.value.corpusFingerprint
      || mockEvaluation.report.value.dirtyTreeFingerprint !== realSyntheticEvaluation.report.value.dirtyTreeFingerprint
    )
  ) {
    throw new Error('Mock and real-synthetic reports were not produced from the same source/corpus state');
  }

  return {
    schemaVersion: 'agent-modernization-baseline.v2',
    capturedAt,
    baseline: {
      commit,
      branch: command(rootDirectory, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']),
      dirtyStatus: command(rootDirectory, 'git', ['status', '--short']),
    },
    toolchain: {
      nodeVersion: observed(process.version, 'process.version'),
      pnpmVersion: command(rootDirectory, 'pnpm', ['--version']),
      packageManager: packageManager
        ? observed(packageManager, 'package.json packageManager')
        : unverified<string>('packageManager missing', 'package.json'),
      aiSdkVersion: dependencyVersion(manifest, 'ai'),
      nextVersion: dependencyVersion(manifest, 'next'),
      lockfileSha256: fingerprint(rootDirectory, 'pnpm-lock.yaml'),
    },
    configuration: {
      fingerprintSha256: observed(
        sha256(FINGERPRINT_PATHS.map((path) => {
          const value = fingerprint(rootDirectory, path);
          return `${path}:${value.status === 'observed' ? value.value : value.status}`;
        }).join('\n')),
        'ordered static configuration fingerprints',
      ),
      files: Object.fromEntries(
        FINGERPRINT_PATHS.map((path) => [path, fingerprint(rootDirectory, path)]),
      ),
      environment,
    },
    modelRoles: effectiveModelRoles(input.environment),
    runtime: {
      vercel: {
        ...vercelLink(rootDirectory),
        plan: notObservable<string>('effective Vercel plan not returned by local project metadata'),
        region: unverified<string>('requires fresh read-only deployment snapshot', 'Vercel project API'),
        fluid: unverified<boolean>('requires fresh read-only deployment snapshot', 'Vercel project API'),
        nodeRuntime: unverified<string>('requires fresh read-only deployment snapshot', 'Vercel project API'),
        routeMaxDurationMs: sourceNumber(
          rootDirectory,
          'src/app/api/chat/route.ts',
          /maxDuration\s*=\s*(\d+)/u,
          1_000,
        ),
        maxMemoryMb: notObservable<number>(
          'no route memory override and effective deployment memory unavailable',
        ),
      },
      database: {
        urlConfigured: environment.sensitiveConfiguration.DATABASE_URL ?? false,
        pooledNeonStatus: notObservable<boolean>(
          'database URL is never serialized or inspected by this report',
        ),
        defaultPoolMax: sourceNumber(
          rootDirectory,
          'packages/infrastructure/src/config/database.ts',
          /DEFAULT_DATABASE_POOL_SIZE\s*=\s*(\d+)/u,
        ),
        productionNeonPoolMax: sourceNumber(
          rootDirectory,
          'packages/infrastructure/src/config/database.ts',
          /DEFAULT_NEON_PRODUCTION_POOL_SIZE\s*=\s*(\d+)/u,
        ),
        hardPoolMax: sourceNumber(
          rootDirectory,
          'packages/infrastructure/src/config/database.ts',
          /MAX_DATABASE_POOL_SIZE\s*=\s*(\d+)/u,
        ),
        statementTimeoutMs: sourceNumber(
          rootDirectory,
          'packages/infrastructure/src/db/pool.ts',
          /DEFAULT_DATABASE_STATEMENT_TIMEOUT_MS\s*=\s*([\d_]+)/u,
        ),
        computeTier: notObservable<string>('Neon account metadata unavailable'),
      },
      upstash: {
        redisConfigured: Boolean(environment.sensitiveConfiguration.UPSTASH_REDIS_REST_URL)
          && Boolean(environment.sensitiveConfiguration.UPSTASH_REDIS_REST_TOKEN),
        qstashConfigured: Boolean(environment.sensitiveConfiguration.QSTASH_TOKEN),
        tier: notObservable<string>('Upstash account metadata unavailable'),
        region: notObservable<string>(
          'Upstash endpoint is never serialized or inspected by this report',
        ),
      },
    },
    corpus: {
      trackedDocumentsDirectory: existsSync(join(rootDirectory, 'documents')),
      liveDocumentCount: notObservable<number>('no approved corpus snapshot source'),
      liveChunkCount: notObservable<number>('no approved corpus snapshot source'),
      liveCorpusFingerprint: notObservable<string>('no approved corpus snapshot source'),
      mockEvaluation,
      realSyntheticEvaluation,
    },
    workloadProfiles,
    measurements: measurementsSnapshot(
      rootDirectory,
      capturedAt,
      measurementEvidence,
      commit,
      realSyntheticEvaluation,
    ),
    commandEvidence,
  };
}

function optionPath(arguments_: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const values = arguments_
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length > 1) throw new Error(`Only one --${name} may be supplied`);
  return values[0] || null;
}

function measurementEvidencePath(arguments_: readonly string[]): string | null {
  return optionPath(arguments_, 'measurements-file');
}

function readMeasurementEvidence(path: string | null): MeasurementEvidence | undefined {
  if (path === null) return undefined;
  return measurementEvidenceSchema.parse(readJson(resolve(path)));
}

function readCommandEvidence(path: string | null): Wp0Evidence {
  if (path === null) throw new Error('--evidence-file is required');
  return wp0EvidenceSchema.parse(readJson(resolve(path)));
}

function main(): void {
  const startedAt = performance.now();
  console.log('[baseline-agent] progress phase=validate-evidence status=started');
  loadDotEnv();
  const rootDirectory = process.cwd();
  const arguments_ = process.argv.slice(2);
  const knownArguments = arguments_.filter((argument) =>
    argument.startsWith('--evidence-file=') || argument.startsWith('--measurements-file='));
  if (knownArguments.length !== arguments_.length) throw new Error('Unknown baseline argument');
  const measurementEvidence = readMeasurementEvidence(measurementEvidencePath(arguments_));
  const report = buildModernizationBaseline({
    capturedAt: new Date().toISOString(),
    rootDirectory,
    environment: process.env,
    commandEvidence: readCommandEvidence(optionPath(arguments_, 'evidence-file')),
    ...(measurementEvidence === undefined ? {} : { measurementEvidence }),
  });
  const outputDirectory = join(rootDirectory, 'eval');
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, 'agent-modernization-baseline.json');
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `[baseline-agent] progress phase=write-baseline status=completed elapsedMs=${Math.round(performance.now() - startedAt)}`,
  );
  console.log(`agent modernization baseline written to ${outputPath}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) main();
