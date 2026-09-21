import type { AppConfig } from '@app/domain/app-config';

export const SYSTEM_PROMPT_VERSION = 4;
export const SEARCH_RESULT_CONTRACT_VERSION = 2;

const WP8_DEFAULT_AGENTIC_RETRIEVE_LIMIT = 10;
const WP8_DEFAULT_AGENTIC_MAX_RETRIES = 1;
const WP8_DEFAULT_AGENTIC_QUERY_REWRITE_ENABLED = true;

function legacyIntegerValue(
  configured: number | undefined,
  envKey: string,
  fallback: number,
  minimum: number,
): number {
  if (configured !== undefined) return configured;
  const raw = process.env[envKey];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function legacyBooleanValue(
  configured: boolean | undefined,
  envKey: string,
  fallback: boolean,
): boolean {
  if (configured !== undefined) return configured;
  const raw = process.env[envKey]?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return fallback;
}

function wp8RemovedConfigValues(cfg: AppConfig) {
  const persisted = cfg.wp8FingerprintCompatibility;
  return {
    agenticRetrieveLimit: legacyIntegerValue(
      persisted?.retrieveLimit,
      'AGENTIC_RETRIEVE_LIMIT',
      WP8_DEFAULT_AGENTIC_RETRIEVE_LIMIT,
      1,
    ),
    agenticMaxRetries: legacyIntegerValue(
      persisted?.maxRetries,
      'AGENTIC_MAX_RETRIES',
      WP8_DEFAULT_AGENTIC_MAX_RETRIES,
      0,
    ),
    agenticQueryRewriteEnabled: legacyBooleanValue(
      persisted?.queryRewriteEnabled,
      'AGENTIC_QUERY_REWRITE_ENABLED',
      WP8_DEFAULT_AGENTIC_QUERY_REWRITE_ENABLED,
    ),
  };
}

/** WP-8's configured default was agentic unless its global kill switch was false. */
export function wp8RetrievalMode(cfg: AppConfig): 'agentic' | 'normal' {
  if (process.env.AGENTIC_ENABLED === 'false') return 'normal';
  return cfg.wp8FingerprintCompatibility?.retrievalMode ?? 'agentic';
}

/** Exact pre-WP-2 field set. Keep frozen for mixed-version turn-result reads. */
function legacyCacheFingerprintFields(cfg: AppConfig, effectiveMode: 'agentic' | 'normal') {
  return {
    mode: effectiveMode,
    retrievalMode: cfg.retrievalMode,
    similarityThreshold: cfg.similarityThreshold,
    hybridEnabled: cfg.hybridEnabled,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
    agentStepBudget: cfg.agentStepBudget,
    auxModel: cfg.auxModel,
    orgName: cfg.orgName,
    audience: cfg.audience,
    agentPersona: cfg.agentPersona,
    customInstructions: cfg.customInstructions,
    outOfScopeTopics: cfg.outOfScopeTopics,
  };
}

function cacheFingerprintFields(cfg: AppConfig, effectiveMode: 'agentic' | 'normal') {
  return {
    mode: effectiveMode,
    retrievalMode: cfg.retrievalMode,
    similarityThreshold: cfg.similarityThreshold,
    rerankerThreshold: cfg.rerankerThreshold,
    hybridEnabled: cfg.hybridEnabled,
    lexicalSearchMode: cfg.lexicalSearchMode,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
    agentStepBudget: cfg.agentStepBudget,
    auxModel: cfg.auxModel,
    orgName: cfg.orgName,
    audience: cfg.audience,
    agentPersona: cfg.agentPersona,
    customInstructions: cfg.customInstructions,
    outOfScopeTopics: cfg.outOfScopeTopics,
  };
}

/**
 * Exact WP-8 field set for the mixed-version turn-result bridge. WP-9 removed
 * these controls from AppConfig. A rollback/test config that still carries
 * them wins; otherwise legacy deployment env values are read, with WP-8
 * defaults as the final fallback. These values never affect current runtime
 * retrieval or answer-cache keys.
 */
function wp8CacheFingerprintFields(
  cfg: AppConfig,
  effectiveMode: 'agentic' | 'normal',
) {
  const legacy = wp8RemovedConfigValues(cfg);
  return {
    mode: effectiveMode,
    retrievalMode: effectiveMode,
    similarityThreshold: cfg.similarityThreshold,
    rerankerThreshold: cfg.rerankerThreshold,
    hybridEnabled: cfg.hybridEnabled,
    lexicalSearchMode: cfg.lexicalSearchMode,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
    agentStepBudget: cfg.agentStepBudget,
    ...legacy,
    auxModel: cfg.auxModel,
    orgName: cfg.orgName,
    audience: cfg.audience,
    agentPersona: cfg.agentPersona,
    customInstructions: cfg.customInstructions,
    outOfScopeTopics: cfg.outOfScopeTopics,
  };
}

/** Exact WP-8 pre-result-contract field set for the stable coordination key. */
function wp8LegacyCacheFingerprintFields(
  cfg: AppConfig,
  effectiveMode: 'agentic' | 'normal',
) {
  const legacy = wp8RemovedConfigValues(cfg);
  return {
    mode: effectiveMode,
    retrievalMode: effectiveMode,
    similarityThreshold: cfg.similarityThreshold,
    hybridEnabled: cfg.hybridEnabled,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
    agentStepBudget: cfg.agentStepBudget,
    ...legacy,
    auxModel: cfg.auxModel,
    orgName: cfg.orgName,
    audience: cfg.audience,
    agentPersona: cfg.agentPersona,
    customInstructions: cfg.customInstructions,
    outOfScopeTopics: cfg.outOfScopeTopics,
  };
}

export function cacheFingerprint(cfg: AppConfig, effectiveMode: 'agentic' | 'normal'): string {
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    resultContractVersion: SEARCH_RESULT_CONTRACT_VERSION,
    ...cacheFingerprintFields(cfg, effectiveMode),
  });
}

/** Pre-WP-1 fingerprint retained only for turn-result idempotency compatibility. */
export function legacySearchResultCacheFingerprint(
  cfg: AppConfig,
  effectiveMode: 'agentic' | 'normal',
): string {
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    ...legacyCacheFingerprintFields(cfg, effectiveMode),
  });
}

/**
 * WP-8's v2 cache fingerprint, retained for the turn-result TTL/idempotency
 * bridge. It must not be used for new answer-cache keys.
 */
export function wp8CacheFingerprint(
  cfg: AppConfig,
): string {
  const effectiveMode = wp8RetrievalMode(cfg);
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    resultContractVersion: SEARCH_RESULT_CONTRACT_VERSION,
    ...wp8CacheFingerprintFields(cfg, effectiveMode),
  });
}

/** WP-8's v1-compatible turn-result fingerprint (without resultContractVersion). */
export function wp8SearchResultCacheFingerprint(
  cfg: AppConfig,
): string {
  const effectiveMode = wp8RetrievalMode(cfg);
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    ...wp8LegacyCacheFingerprintFields(cfg, effectiveMode),
  });
}
