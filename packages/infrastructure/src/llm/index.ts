import type {
  EmbeddingService,
  Reranker,
  QueryRewriter,
  DocumentGrader,
  HallucinationGrader,
} from '@app/domain';
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
import {
  createGraders,
  queryRewriter,
  documentGrader,
  hallucinationGrader,
} from './graders';

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

/**
 * Return the agentic-loop graders, or `undefined` for each when the loop is
 * disabled (`AGENTIC_ENABLED=false`).
 */
export function getGraders(enabled?: boolean, gradeModelId?: string): {
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
  return gradeModelId ? createGraders(gradeModelId) : { queryRewriter, documentGrader, hallucinationGrader };
}

export { getEmbeddingModel, EMBEDDING_OPTIONS } from './google-embedding-service';
export {
  docSummarizer,
  localReranker,
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
