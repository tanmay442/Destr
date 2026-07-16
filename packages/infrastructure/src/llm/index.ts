import type { EmbeddingService, Reranker } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { googleEmbeddingService } from './google-embedding-service-port';
import { openAIEmbeddingService } from './openai-embedding-service';
import { ollamaEmbeddingService } from './ollama-embedding-service';
import { getChatModel as getOpenAIChatModel } from './openai-chat-service';
import { getGoogleChatModel } from './google-chat-service';
import { getOllamaChatModel } from './ollama-chat-service';
import { docSummarizer } from './doc-summarizer';
import { localReranker } from './local-reranker';
import { cohereReranker } from './cohere-reranker';

export function getEmbeddingService(): EmbeddingService {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  switch (provider) {
    case 'google':
      return googleEmbeddingService;
    case 'openai':
      return openAIEmbeddingService;
    case 'ollama':
      return ollamaEmbeddingService;
    default:
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  }
}

export function getChatModel(modelId?: string): LanguageModelV3 {
  const provider = process.env.CHAT_PROVIDER ?? 'openai';
  switch (provider) {
    case 'openai':
      return getOpenAIChatModel(modelId);
    case 'google':
      return getGoogleChatModel(modelId);
    case 'ollama':
      return getOllamaChatModel(modelId);
    default:
      throw new Error(`Unknown CHAT_PROVIDER: ${provider}`);
  }
}

/** Select the second-stage reranker adapter (Session 6). `local` runs an
 *  on-device cross-encoder (no key required); `cohere` uses the hosted Rerank
 *  API (requires `COHERE_API_KEY`). Defaults to `local`. */
/**
 * Select the second-stage reranker adapter (Session 6).
 *
 * `RERANKER_PROVIDER` chooses between three modes:
 *   - 'cosine' : the original pre-Session-6 bi-encoder ordering. No reranker is
 *               loaded — returns `undefined`, so `searchChunks` keeps its OG
 *               vector behaviour. This is the safe serverless default.
 *   - 'local'  : on-device Xenova cross-encoder (`localReranker`), no API key.
 *   - 'cohere' : hosted Cohere Rerank API (`cohereReranker`). If `COHERE_API_KEY`
 *               is missing, returns `undefined` (→ cosine) instead of attempting a
 *               call that would fail — a clean switch rather than a thrown error.
 *
 * In every case, if the chosen reranker later fails at runtime (model won't load,
 * API error, etc.), `searchChunks` automatically falls back to cosine ordering.
 */
export function getReranker(provider?: string): Reranker | undefined {
  const selected = provider ?? process.env.RERANKER_PROVIDER ?? 'cosine';
  switch (selected) {
    case 'local':
      return localReranker;
    case 'cohere':
      // No key → don't attempt a doomed call; behave as cosine.
      return process.env.COHERE_API_KEY ? cohereReranker : undefined;
    case 'cosine':
    default:
      return undefined;
  }
}

export { getEmbeddingModel, EMBEDDING_OPTIONS } from './google-embedding-service';
export { docSummarizer, localReranker, cohereReranker };

/** Resolve the resolved embedding model id string for the active provider.
 *  Used to stamp `DocumentChunk.embeddingModel` metadata from within
 *  infrastructure (the application layer must not import infrastructure, so it
 *  cannot read the provider-specific model id itself). */
export function getEmbeddingModelId(): string {
  const provider = process.env.EMBEDDING_PROVIDER ?? 'google';
  switch (provider) {
    case 'google':
      return 'gemini-embedding-001';
    case 'openai':
      return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    case 'ollama':
      return process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma:latest';
    default:
      return 'unknown';
  }
}
