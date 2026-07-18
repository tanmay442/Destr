import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';

export function getOllamaEmbeddingModel(): EmbeddingModelV3 {
  const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  const modelId = process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma:latest';
  return provider.textEmbedding(modelId) as EmbeddingModelV3;
}

export const ollamaEmbeddingService: EmbeddingService = {
  async embed(value: string): Promise<number[]> {
    const embeddings = await embedBatchWithModel([value], getOllamaEmbeddingModel());
    const first = embeddings[0];
    return first ?? [];
  },

  async embedBatch(values: string[]): Promise<number[][]> {
    return embedBatchWithModel(values, getOllamaEmbeddingModel());
  },
};
