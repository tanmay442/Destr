import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService } from '@app/domain';
import { resolveVectorDim } from '../db/schema-vector';
import { embedBatchWithModel } from './embedding-batch-helper';
import { normalizeOpenAIBaseURL } from './openai-base-url';
import { registerEmbeddingProvider, registerEmbeddingModelIdProvider } from './registries';

function getOpenAIEmbeddingModel(): EmbeddingModelV3 {
  const apiKey = process.env.OPENAI_EMBEDDING_API_KEY ?? process.env.CUSTOM_LLM_API_KEY;
  const baseURL = process.env.OPENAI_EMBEDDING_BASE_URL ?? process.env.CUSTOM_LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error(
      'OPENAI_EMBEDDING_API_KEY and OPENAI_EMBEDDING_BASE_URL must be set (or CUSTOM_LLM_API_KEY/CUSTOM_LLM_BASE_URL).',
    );
  }
  const provider = createOpenAI({ apiKey, baseURL: normalizeOpenAIBaseURL(baseURL) });
  const modelId = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  return provider.textEmbedding(modelId) as EmbeddingModelV3;
}

function getOpenAIEmbeddingOptions(vectorDim?: number) {
  return {
    openai: {
      dimensions: vectorDim ?? resolveVectorDim(),
    },
  } as const;
}

function assertDimension(modelId: string, embeddings: number[][], vectorDim?: number): void {
  const expected = vectorDim ?? resolveVectorDim();
  for (const embedding of embeddings) {
    if (embedding.length !== expected) {
      throw new Error(
        `OpenAI embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${expected} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

function createOpenAIEmbeddingService(vectorDim?: number): EmbeddingService {
  const getProviderOptions = () => getOpenAIEmbeddingOptions(vectorDim);
  return {
    async embed(value: string): Promise<number[]> {
      const model = getOpenAIEmbeddingModel();
      const embeddings = await embedBatchWithModel([value], model, getProviderOptions());
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings[0] ?? [];
    },

    async embedBatch(values: string[]): Promise<number[][]> {
      const model = getOpenAIEmbeddingModel();
      const embeddings = await embedBatchWithModel(values, model, getProviderOptions());
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings;
    },
  };
}

export const openAIEmbeddingService = createOpenAIEmbeddingService();

registerEmbeddingProvider('openai', (vectorDim) =>
  vectorDim === undefined ? openAIEmbeddingService : createOpenAIEmbeddingService(vectorDim),
);
registerEmbeddingModelIdProvider('openai', () => process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small');
