import type { AppConfig } from '@app/domain/app-config';

export const SYSTEM_PROMPT_VERSION = 4;
export const SEARCH_RESULT_CONTRACT_VERSION = 2;

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
    agenticRetrieveLimit: cfg.agenticRetrieveLimit,
    agenticMaxRetries: cfg.agenticMaxRetries,
    agenticQueryRewriteEnabled: cfg.agenticQueryRewriteEnabled,
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
    agenticRetrieveLimit: cfg.agenticRetrieveLimit,
    agenticMaxRetries: cfg.agenticMaxRetries,
    agenticQueryRewriteEnabled: cfg.agenticQueryRewriteEnabled,
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
