import {
  BLOB_GET_MAX_BYTES as DEFAULT_BLOB_GET_MAX_BYTES,
  UPLOAD_CHUNKED_MAX_MD_BYTES as DEFAULT_UPLOAD_CHUNKED_MAX_MD_BYTES,
  UPLOAD_CHUNKED_MAX_PDF_BYTES as DEFAULT_UPLOAD_CHUNKED_MAX_PDF_BYTES,
  PDF_PARSE_MAX_BYTES as DEFAULT_PDF_PARSE_MAX_BYTES,
  PDF_PARSE_MAX_PAGES as DEFAULT_PDF_PARSE_MAX_PAGES,
  PDF_PARSE_MAX_CHARS as DEFAULT_PDF_PARSE_MAX_CHARS,
  CCH_MODEL as DEFAULT_CCH_MODEL,
  MD_CHUNK_DELIMITER as DEFAULT_MD_CHUNK_DELIMITER,
  INGEST_CHUNK_SIZE as DEFAULT_INGEST_CHUNK_SIZE,
  PARENT_CHUNK_SIZE as DEFAULT_PARENT_CHUNK_SIZE,
  CHILD_CHUNK_SIZE as DEFAULT_CHILD_CHUNK_SIZE,
  PARENT_CHILD_MODE as DEFAULT_PARENT_CHILD_MODE,
  PARENT_CHILD_WINDOW as DEFAULT_PARENT_CHILD_WINDOW,
  RERANKER_PROVIDER as DEFAULT_RERANKER_PROVIDER,
  CANDIDATE_POOL as DEFAULT_CANDIDATE_POOL,
  RERANK_TOP_N as DEFAULT_RERANK_TOP_N,
  RRF_K as DEFAULT_RRF_K,
  LEXICAL_WEIGHT as DEFAULT_LEXICAL_WEIGHT,
  AUX_MODEL as DEFAULT_AUX_MODEL,
  OUT_OF_DOMAIN_THRESHOLD as DEFAULT_OUT_OF_DOMAIN_THRESHOLD,
  AGENT_STEP_BUDGET as DEFAULT_AGENT_STEP_BUDGET,
  AGENTIC_RETRIEVE_LIMIT as DEFAULT_AGENTIC_RETRIEVE_LIMIT,
  AGENTIC_MAX_RETRIES as DEFAULT_AGENTIC_MAX_RETRIES,
  ANSWER_CACHE_TTL_SEC as DEFAULT_ANSWER_CACHE_TTL_SEC,
  EVAL_FAITHFULNESS_THRESHOLD as DEFAULT_EVAL_FAITHFULNESS_THRESHOLD,
} from '@app/domain';
import type { EnvSource, LogLevel, RuntimeConfig } from '@app/domain';

const VALID_LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

function finiteOrDefault(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveIntegerOrDefault(value: string | undefined, fallback: number): number {
  const n = finiteOrDefault(value, fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonnegativeIntegerOrDefault(value: string | undefined, fallback: number): number {
  const n = finiteOrDefault(value, fallback);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function positiveOrDefault(value: string | undefined, fallback: number): number {
  const n = finiteOrDefault(value, fallback);
  return n > 0 ? n : fallback;
}

function nonnegativeOrDefault(value: string | undefined, fallback: number): number {
  const n = finiteOrDefault(value, fallback);
  return n >= 0 ? n : fallback;
}

function probabilityOrDefault(value: string | undefined, fallback: number): number {
  const n = finiteOrDefault(value, fallback);
  return n >= 0 && n <= 1 ? n : fallback;
}

function enumOrDefault<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export const defaultProcessEnv: EnvSource = { get: (k) => process.env[k] };

function resolveRuntimeConfig(env: EnvSource) {
  const LOG_LEVEL: LogLevel = VALID_LOG_LEVELS.includes(env.get('LOG_LEVEL') as LogLevel)
    ? (env.get('LOG_LEVEL') as LogLevel)
    : 'info';

  const BLOB_GET_MAX_BYTES = positiveIntegerOrDefault(env.get('BLOB_GET_MAX_BYTES'), DEFAULT_BLOB_GET_MAX_BYTES);
  const UPLOAD_CHUNKED_MAX_MD_BYTES = positiveIntegerOrDefault(env.get('UPLOAD_CHUNKED_MAX_MD_BYTES'), DEFAULT_UPLOAD_CHUNKED_MAX_MD_BYTES);
  const UPLOAD_CHUNKED_MAX_PDF_BYTES = positiveIntegerOrDefault(env.get('UPLOAD_CHUNKED_MAX_PDF_BYTES'), DEFAULT_UPLOAD_CHUNKED_MAX_PDF_BYTES);
  const PDF_PARSE_MAX_BYTES = positiveIntegerOrDefault(env.get('PDF_PARSE_MAX_BYTES'), DEFAULT_PDF_PARSE_MAX_BYTES);
  const PDF_PARSE_MAX_PAGES = positiveIntegerOrDefault(env.get('PDF_PARSE_MAX_PAGES'), DEFAULT_PDF_PARSE_MAX_PAGES);
  const PDF_PARSE_MAX_CHARS = positiveIntegerOrDefault(env.get('PDF_PARSE_MAX_CHARS'), DEFAULT_PDF_PARSE_MAX_CHARS);
  const CCH_ENABLED = env.get('CCH_ENABLED') !== 'false';
  const CCH_MODEL = env.get('CCH_MODEL') ?? DEFAULT_CCH_MODEL;
  const configuredDelimiter = env.get('MD_CHUNK_DELIMITER');
  const MD_CHUNK_DELIMITER = configuredDelimiter &&
    configuredDelimiter.length <= 200 &&
    configuredDelimiter.trim() !== '' &&
    !/[\r\n]/.test(configuredDelimiter)
    ? configuredDelimiter
    : DEFAULT_MD_CHUNK_DELIMITER;
  const CHUNKING_STRATEGY = enumOrDefault(
    env.get('CHUNKING_STRATEGY'),
    ['document-aware', 'recursive-adaptive', 'semantic', 'parent-child'] as const,
    'document-aware',
  );
  const INGEST_CHUNK_SIZE = positiveIntegerOrDefault(env.get('INGEST_CHUNK_SIZE'), DEFAULT_INGEST_CHUNK_SIZE);
  const INGEST_CHUNK_OVERLAP = Math.floor(INGEST_CHUNK_SIZE / 10);
  const PARENT_CHUNK_SIZE = positiveIntegerOrDefault(env.get('PARENT_CHUNK_SIZE'), DEFAULT_PARENT_CHUNK_SIZE);
  const CHILD_CHUNK_SIZE = positiveIntegerOrDefault(env.get('CHILD_CHUNK_SIZE'), DEFAULT_CHILD_CHUNK_SIZE);
  const PARENT_CHILD_MODE = enumOrDefault(env.get('PARENT_CHILD_MODE'), ['parent', 'window'] as const, DEFAULT_PARENT_CHILD_MODE);
  const PARENT_CHILD_WINDOW = nonnegativeIntegerOrDefault(env.get('PARENT_CHILD_WINDOW'), DEFAULT_PARENT_CHILD_WINDOW);
  const RERANKER_PROVIDER = enumOrDefault(env.get('RERANKER_PROVIDER'), ['cosine', 'local', 'cohere'] as const, DEFAULT_RERANKER_PROVIDER);
  const CANDIDATE_POOL = positiveIntegerOrDefault(env.get('CANDIDATE_POOL'), DEFAULT_CANDIDATE_POOL);
  const RERANK_TOP_N = positiveIntegerOrDefault(env.get('RERANK_TOP_N'), DEFAULT_RERANK_TOP_N);
  const HYBRID_ENABLED = env.get('HYBRID_ENABLED') !== 'false';
  const RRF_K = positiveOrDefault(env.get('RRF_K'), DEFAULT_RRF_K);
  const LEXICAL_WEIGHT = nonnegativeOrDefault(env.get('LEXICAL_WEIGHT'), DEFAULT_LEXICAL_WEIGHT);
  const AGENTIC_ENABLED = env.get('AGENTIC_ENABLED') !== 'false';
  const AUX_MODEL = env.get('AUX_MODEL') ?? DEFAULT_AUX_MODEL;
  const OUT_OF_DOMAIN_THRESHOLD = probabilityOrDefault(env.get('OUT_OF_DOMAIN_THRESHOLD'), DEFAULT_OUT_OF_DOMAIN_THRESHOLD);
  const AGENT_STEP_BUDGET = positiveIntegerOrDefault(env.get('AGENT_STEP_BUDGET'), DEFAULT_AGENT_STEP_BUDGET);
  const AGENTIC_RETRIEVE_LIMIT = positiveIntegerOrDefault(env.get('AGENTIC_RETRIEVE_LIMIT'), DEFAULT_AGENTIC_RETRIEVE_LIMIT);
  const AGENTIC_MAX_RETRIES = nonnegativeIntegerOrDefault(env.get('AGENTIC_MAX_RETRIES'), DEFAULT_AGENTIC_MAX_RETRIES);
  const ANSWER_CACHE_ENABLED = env.get('ANSWER_CACHE_ENABLED') !== 'false';
  const ANSWER_CACHE_TTL_SEC = positiveIntegerOrDefault(env.get('ANSWER_CACHE_TTL_SEC'), DEFAULT_ANSWER_CACHE_TTL_SEC);
  const TRACE_ENABLED = env.get('TRACE_ENABLED') === 'true';
  const EVAL_FAITHFULNESS_THRESHOLD = probabilityOrDefault(env.get('EVAL_FAITHFULNESS_THRESHOLD'), DEFAULT_EVAL_FAITHFULNESS_THRESHOLD);

  return {
    LOG_LEVEL,
    BLOB_GET_MAX_BYTES,
    UPLOAD_CHUNKED_MAX_MD_BYTES,
    UPLOAD_CHUNKED_MAX_PDF_BYTES,
    PDF_PARSE_MAX_BYTES,
    PDF_PARSE_MAX_PAGES,
    PDF_PARSE_MAX_CHARS,
    CCH_ENABLED,
    CCH_MODEL,
    MD_CHUNK_DELIMITER,
    CHUNKING_STRATEGY,
    INGEST_CHUNK_SIZE,
    INGEST_CHUNK_OVERLAP,
    PARENT_CHUNK_SIZE,
    CHILD_CHUNK_SIZE,
    PARENT_CHILD_MODE,
    PARENT_CHILD_WINDOW,
    RERANKER_PROVIDER,
    CANDIDATE_POOL,
    RERANK_TOP_N,
    HYBRID_ENABLED,
    RRF_K,
    LEXICAL_WEIGHT,
    AGENTIC_ENABLED,
    AUX_MODEL,
    OUT_OF_DOMAIN_THRESHOLD,
    AGENT_STEP_BUDGET,
    AGENTIC_RETRIEVE_LIMIT,
    AGENTIC_MAX_RETRIES,
    ANSWER_CACHE_ENABLED,
    ANSWER_CACHE_TTL_SEC,
    TRACE_ENABLED,
    EVAL_FAITHFULNESS_THRESHOLD,
  };
}

let _defaultConfig: RuntimeConfig | undefined;

/**
 * Resolves runtime configuration from an EnvSource.
 *
 * INTENTIONAL DESIGN:
 * For `defaultProcessEnv`, environment variables are resolved once at process startup
 * and memoized in `_defaultConfig` to eliminate process.env parsing overhead on hot paths.
 * Explicit `env` parameters (e.g. test fakes) bypass memoization and resolve freshly.
 */
export function loadEnvConfig(env: EnvSource = defaultProcessEnv): RuntimeConfig {
  if (env === defaultProcessEnv) {
    _defaultConfig ??= Object.freeze(resolveRuntimeConfig(env));
    return _defaultConfig;
  }
  return Object.freeze(resolveRuntimeConfig(env));
}

const defaultConfig = loadEnvConfig();

export const LOG_LEVEL: LogLevel = defaultConfig.LOG_LEVEL as LogLevel;
export const BLOB_GET_MAX_BYTES: number = defaultConfig.BLOB_GET_MAX_BYTES as number;
export const UPLOAD_CHUNKED_MAX_MD_BYTES: number = defaultConfig.UPLOAD_CHUNKED_MAX_MD_BYTES as number;
export const UPLOAD_CHUNKED_MAX_PDF_BYTES: number = defaultConfig.UPLOAD_CHUNKED_MAX_PDF_BYTES as number;
export const PDF_PARSE_MAX_BYTES: number = defaultConfig.PDF_PARSE_MAX_BYTES as number;
export const PDF_PARSE_MAX_PAGES: number = defaultConfig.PDF_PARSE_MAX_PAGES as number;
export const PDF_PARSE_MAX_CHARS: number = defaultConfig.PDF_PARSE_MAX_CHARS as number;
export const CCH_ENABLED: boolean = defaultConfig.CCH_ENABLED as boolean;
export const CCH_MODEL: string = defaultConfig.CCH_MODEL as string;
export const MD_CHUNK_DELIMITER: string = defaultConfig.MD_CHUNK_DELIMITER as string;
export const CHUNKING_STRATEGY: 'document-aware' | 'recursive-adaptive' | 'semantic' | 'parent-child' =
  defaultConfig.CHUNKING_STRATEGY as 'document-aware' | 'recursive-adaptive' | 'semantic' | 'parent-child';
export const INGEST_CHUNK_SIZE: number = defaultConfig.INGEST_CHUNK_SIZE as number;
export const INGEST_CHUNK_OVERLAP: number = defaultConfig.INGEST_CHUNK_OVERLAP as number;
export const PARENT_CHUNK_SIZE: number = defaultConfig.PARENT_CHUNK_SIZE as number;
export const CHILD_CHUNK_SIZE: number = defaultConfig.CHILD_CHUNK_SIZE as number;
export const PARENT_CHILD_MODE: 'parent' | 'window' = defaultConfig.PARENT_CHILD_MODE as 'parent' | 'window';
export const PARENT_CHILD_WINDOW: number = defaultConfig.PARENT_CHILD_WINDOW as number;
export const RERANKER_PROVIDER: 'cosine' | 'local' | 'cohere' = defaultConfig.RERANKER_PROVIDER as 'cosine' | 'local' | 'cohere';
export const CANDIDATE_POOL: number = defaultConfig.CANDIDATE_POOL as number;
export const RERANK_TOP_N: number = defaultConfig.RERANK_TOP_N as number;
export const HYBRID_ENABLED: boolean = defaultConfig.HYBRID_ENABLED as boolean;
export const RRF_K: number = defaultConfig.RRF_K as number;
export const LEXICAL_WEIGHT: number = defaultConfig.LEXICAL_WEIGHT as number;
export const AGENTIC_ENABLED: boolean = defaultConfig.AGENTIC_ENABLED as boolean;
export const AUX_MODEL: string = defaultConfig.AUX_MODEL as string;
export const OUT_OF_DOMAIN_THRESHOLD: number = defaultConfig.OUT_OF_DOMAIN_THRESHOLD as number;
export const AGENT_STEP_BUDGET: number = defaultConfig.AGENT_STEP_BUDGET as number;
export const AGENTIC_RETRIEVE_LIMIT: number = defaultConfig.AGENTIC_RETRIEVE_LIMIT as number;
export const AGENTIC_MAX_RETRIES: number = defaultConfig.AGENTIC_MAX_RETRIES as number;
export const ANSWER_CACHE_ENABLED: boolean = defaultConfig.ANSWER_CACHE_ENABLED as boolean;
export const ANSWER_CACHE_TTL_SEC: number = defaultConfig.ANSWER_CACHE_TTL_SEC as number;
export const TRACE_ENABLED: boolean = defaultConfig.TRACE_ENABLED as boolean;
export const EVAL_FAITHFULNESS_THRESHOLD: number = defaultConfig.EVAL_FAITHFULNESS_THRESHOLD as number;
