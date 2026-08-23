import type { AppConfig } from '@app/domain/app-config';

export const SYSTEM_PROMPT_VERSION = 3;

export function cacheFingerprint(cfg: AppConfig, effectiveMode: 'agentic' | 'normal'): string {
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    mode: effectiveMode,
    retrievalMode: cfg.retrievalMode,
    similarityThreshold: cfg.similarityThreshold,
    hybridEnabled: cfg.hybridEnabled,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
    agentStepBudget: cfg.agentStepBudget,
    agenticRetrieveLimit: cfg.agenticRetrieveLimit,
    agenticMaxRetries: cfg.agenticMaxRetries,
    // §B1: these two change retrieved context ⇒ answer text (hallucinationCheckEnabled only gates banner/caching, so excluded).
    agenticQueryRewriteEnabled: cfg.agenticQueryRewriteEnabled,
    agenticChunkGradingEnabled: cfg.agenticChunkGradingEnabled,
    gradeModel: cfg.gradeModel,
    orgName: cfg.orgName,
    audience: cfg.audience,
    agentPersona: cfg.agentPersona,
    customInstructions: cfg.customInstructions,
    outOfScopeTopics: cfg.outOfScopeTopics,
  });
}
