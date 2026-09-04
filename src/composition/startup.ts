import { Db, Llm } from '@app/infrastructure';
import { defaultProcessEnv } from '@app/infrastructure/config';
import { logger } from '../lib/logger';
import { registerSettingsRepoProvider } from '../lib/config/runtime';
import { createComposition, type Composition } from './factory';
import { embeddingService } from './infra';

let _composition: Composition | null = null;
export function getComposition(): Composition {
  if (!_composition) _composition = createComposition();
  return _composition;
}

registerSettingsRepoProvider(() => getComposition().settingsRepo);

let _vectorCheckStarted = false;
export function startVectorDimensionCheck(): void {
  if (_vectorCheckStarted) return;
  _vectorCheckStarted = true;
  Db.validateVectorDimension(defaultProcessEnv, () =>
    embeddingService.embed('embedding dimension probe'),
  ).catch((e: unknown) => {
    logger.error('Embedding dimension validation failed at startup', { error: e });
  });
}

let _rerankerCheckStarted = false;
export function startLocalRerankerCheck(): void {
  if (_rerankerCheckStarted) return;
  _rerankerCheckStarted = true;
  if (process.env.RERANKER_PROVIDER !== 'local') return;
  Llm.checkLocalRerankerAvailable().then((available) => {
    if (available) return;
    logger.warn('RERANKER_PROVIDER=local but @xenova/transformers is not installed; reranking silently falls back to cosine ordering. Install the optional dependency or set RERANKER_PROVIDER=cosine/cohere.');
    Llm.updateRerankerAvailability('local', { reranker: undefined, status: { ok: false, reason: '@xenova/transformers is not installed' } });
  });
}
