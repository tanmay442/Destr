import type { AppConfig } from '@app/domain/app-config';

export const SYSTEM_PROMPT_VERSION = 2;

export function cacheFingerprint(cfg: AppConfig, effectiveMode: 'agentic' | 'normal'): string {
  return JSON.stringify({
    promptVersion: SYSTEM_PROMPT_VERSION,
    mode: effectiveMode,
    retrievalMode: cfg.retrievalMode,
    similarityThreshold: cfg.similarityThreshold,
    hybridEnabled: cfg.hybridEnabled,
    rerankerProvider: cfg.rerankerProvider,
    prefetchFirstTurn: cfg.prefetchFirstTurn,
  });
}
