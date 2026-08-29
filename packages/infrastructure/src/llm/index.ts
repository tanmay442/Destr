import type {
  EmbeddingService,
  Reranker,
  QueryRewriter,
  HallucinationGrader,
} from '@app/domain';
import './openai-chat-service';
import './google-chat-service';
import './ollama-chat-service';
import './google-embedding-service';
import './google-embedding-service-port';
import './openai-embedding-service';
import './ollama-embedding-service';
import { docSummarizer, createDocSummarizer } from './doc-summarizer';
import { localReranker, checkLocalRerankerAvailable } from './local-reranker';
import { cohereReranker } from './cohere-reranker';
import { createAuxModels } from './aux';
import {
  embeddingProviderRegistry,
  rerankerProviderRegistry,
  embeddingModelIdRegistry,
  registerRerankerProvider,
  type ChatModelProvider,
} from './registries';
import { getChatModel } from './model';

export { getChatModel } from './model';

export function getEmbeddingService(vectorDim?: number): EmbeddingService {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  const factory = embeddingProviderRegistry.get(provider);
  if (!factory) throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  return factory(vectorDim);
}

/**
 * Select the second-stage reranker adapter.
 *
 * `RERANKER_PROVIDER` chooses between three modes:
 *   - 'cosine' : no reranker loaded, returns `undefined` (vector ordering only).
 *   - 'local'  : on-device Xenova cross-encoder, no API key.
 *   - 'cohere' : hosted Cohere Rerank API. Falls back to cosine if
 *               `COHERE_API_KEY` is missing.
 */
export function getReranker(provider?: string): Reranker | undefined {
  const selected = provider ?? process.env.RERANKER_PROVIDER ?? 'cosine';
  const factory = rerankerProviderRegistry.get(selected);
  if (!factory) return undefined;
  return factory();
}

registerRerankerProvider('cosine', () => undefined);

export type RerankerStatus = { ok: boolean; reason?: string | undefined };

export interface RerankerAvailability {
  reranker?: Reranker | undefined;
  status: RerankerStatus;
}

const rerankerOverrides = new Map<string, RerankerAvailability>();

function getRerankerRegistry(): Map<string, RerankerAvailability> {
  const base = new Map<string, RerankerAvailability>([
    ['cosine', { reranker: undefined, status: { ok: true } }],
    [
      'cohere',
      process.env.COHERE_API_KEY
        ? { reranker: getReranker('cohere'), status: { ok: true } }
        : { reranker: undefined, status: { ok: false, reason: 'COHERE_API_KEY not set' } },
    ],
    [
      'local',
      process.env.VERCEL
        ? { reranker: undefined, status: { ok: false, reason: 'local reranker unavailable on Vercel serverless' } }
        : { reranker: getReranker('local'), status: { ok: true } },
    ],
  ]);
  for (const [k, v] of rerankerOverrides) base.set(k, v);
  return base;
}

export function availableRerankers(): Map<string, RerankerStatus> {
  return new Map([...getRerankerRegistry()].map(([name, entry]) => [name, entry.status]));
}

export function resolveReranker(provider: string): Reranker | undefined {
  return getRerankerRegistry().get(provider)?.reranker;
}

export function updateRerankerAvailability(provider: string, availability: RerankerAvailability): void {
  rerankerOverrides.set(provider, availability);
}

/**
 * Return the agentic-loop aux models, or `undefined` for each when the loop is
 * disabled (`AGENTIC_ENABLED=false`).
 */
export function getAuxModels(
  enabled?: boolean,
  auxModelId?: string,
  modelProvider: ChatModelProvider = getChatModel,
): {
  queryRewriter: QueryRewriter | undefined;
  hallucinationGrader: HallucinationGrader | undefined;
} {
  const on = enabled ?? process.env.AGENTIC_ENABLED !== 'false';
  if (!on) {
    return {
      queryRewriter: undefined,
      hallucinationGrader: undefined,
    };
  }
  const aux = createAuxModels(auxModelId, modelProvider);
  return {
    queryRewriter: aux.queryRewriter,
    hallucinationGrader: aux.hallucinationGrader,
  };
}

export { getEmbeddingModel, getGoogleEmbeddingOptions, EMBEDDING_OPTIONS, getGoogleEmbeddingModelId } from './google-embedding-service';
export {
  docSummarizer,
  createDocSummarizer,
  localReranker,
  checkLocalRerankerAvailable,
  cohereReranker,
  createAuxModels,
};
export { judgeRelevance, judgeFaithfulness } from './judge';

/** Resolve the embedding model id string for the active provider.
 *  Used to stamp `DocumentChunk.embeddingModel` metadata. */
export function getEmbeddingModelId(): string {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  const factory = embeddingModelIdRegistry.get(provider);
  if (!factory) return 'unknown';
  return factory();
}
