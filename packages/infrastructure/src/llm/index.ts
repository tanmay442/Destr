import type {
  EmbeddingService,
  Reranker,
  QueryRewriter,
  DocumentGrader,
  HallucinationGrader,
} from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
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
import {
  createGraders,
  queryRewriter,
  documentGrader,
  hallucinationGrader,
} from './graders';
import {
  chatProviderRegistry,
  embeddingProviderRegistry,
  rerankerProviderRegistry,
  embeddingModelIdRegistry,
  registerRerankerProvider,
  type ChatModelProvider,
} from './registries';

export function getEmbeddingService(): EmbeddingService {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  const service = embeddingProviderRegistry.get(provider);
  if (!service) throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  return service;
}

export function getChatModel(modelId?: string): LanguageModelV3 {
  const provider = process.env.CHAT_PROVIDER ?? 'openai';
  const factory = chatProviderRegistry.get(provider);
  if (!factory) throw new Error(`Unknown CHAT_PROVIDER: ${provider}`);
  return factory(modelId);
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

/**
 * Return the agentic-loop graders, or `undefined` for each when the loop is
 * disabled (`AGENTIC_ENABLED=false`).
 */
export function getGraders(
  enabled?: boolean,
  gradeModelId?: string,
  modelProvider: ChatModelProvider = getChatModel,
): {
  queryRewriter: QueryRewriter | undefined;
  documentGrader: DocumentGrader | undefined;
  hallucinationGrader: HallucinationGrader | undefined;
} {
  const on = enabled ?? process.env.AGENTIC_ENABLED !== 'false';
  if (!on) {
    return {
      queryRewriter: undefined,
      documentGrader: undefined,
      hallucinationGrader: undefined,
    };
  }
  if (modelProvider === getChatModel && !gradeModelId) {
    return { queryRewriter, documentGrader, hallucinationGrader };
  }
  const graders = createGraders(gradeModelId, modelProvider);
  return {
    queryRewriter: graders.queryRewriter,
    documentGrader: graders.documentGrader,
    hallucinationGrader: graders.hallucinationGrader,
  };
}

export { getEmbeddingModel, EMBEDDING_OPTIONS, getGoogleEmbeddingModelId } from './google-embedding-service';
export {
  docSummarizer,
  createDocSummarizer,
  localReranker,
  checkLocalRerankerAvailable,
  cohereReranker,
  createGraders,
  queryRewriter,
  documentGrader,
  hallucinationGrader,
};

/** Resolve the embedding model id string for the active provider.
 *  Used to stamp `DocumentChunk.embeddingModel` metadata. */
export function getEmbeddingModelId(): string {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  const factory = embeddingModelIdRegistry.get(provider);
  if (!factory) return 'unknown';
  return factory();
}
