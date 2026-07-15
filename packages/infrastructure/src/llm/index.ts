import type { EmbeddingService } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { googleEmbeddingService } from './google-embedding-service-port';
import { openAIEmbeddingService } from './openai-embedding-service';
import { ollamaEmbeddingService } from './ollama-embedding-service';
import { getChatModel as getOpenAIChatModel } from './openai-chat-service';
import { getGoogleChatModel } from './google-chat-service';
import { getOllamaChatModel } from './ollama-chat-service';
import { docSummarizer } from './doc-summarizer';

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

export { getEmbeddingModel, EMBEDDING_OPTIONS } from './google-embedding-service';
export { docSummarizer };
