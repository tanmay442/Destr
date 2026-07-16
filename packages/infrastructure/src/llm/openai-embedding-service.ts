import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { embed } from 'ai';
import type { EmbeddingService } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';

export function getOpenAIEmbeddingModel(): EmbeddingModelV3 {
  const apiKey = process.env.OPENAI_EMBEDDING_API_KEY ?? process.env.CUSTOM_LLM_API_KEY;
  const baseURL = process.env.OPENAI_EMBEDDING_BASE_URL ?? process.env.CUSTOM_LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      'OPENAI_EMBEDDING_API_KEY and OPENAI_EMBEDDING_BASE_URL must be set (or CUSTOM_LLM_API_KEY/CUSTOM_LLM_BASE_URL).',
    );
  }
  // Normalize base URL: the SDK appends the endpoint path (/embeddings),
  // so strip any trailing path beyond /v1 to avoid double-pathing.
  const normalizedBaseURL = baseURL.replace(/\/v1\/?.+$/, '/v1');
  const provider = createOpenAI({ apiKey, baseURL: normalizedBaseURL });
  const modelId = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  return provider.textEmbedding(modelId) as EmbeddingModelV3;
}

function getOpenAIEmbeddingOptions() {
  return {
    openai: {
      dimensions: Number(process.env.EMBEDDING_DIMENSION) || 768,
    },
  } as const;
}

export const openAIEmbeddingService: EmbeddingService = {
  async embed(value: string): Promise<number[]> {
    const { embedding } = await embed({
      model: getOpenAIEmbeddingModel(),
      value,
      providerOptions: getOpenAIEmbeddingOptions(),
    });
    return embedding;
  },

  async embedBatch(values: string[]): Promise<number[][]> {
    return embedBatchWithModel(values, getOpenAIEmbeddingModel(), getOpenAIEmbeddingOptions());
  },
};
