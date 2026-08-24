import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService } from '@app/domain';
import { VECTOR_DIM } from '../db/schema-vector';
import { embedBatchWithModel } from './embedding-batch-helper';
import { registerEmbeddingProvider, registerEmbeddingModelIdProvider } from './registries';

function getOllamaEmbeddingModelId(): string {
  return process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma:latest';
}

function getOllamaEmbeddingModel(): EmbeddingModelV3 {
  const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  return provider.textEmbedding(getOllamaEmbeddingModelId()) as EmbeddingModelV3;
}

/** Ollama embeddings cannot pin a dimension up front, so validate the output
 *  width against the vector column here — a clear config error before the
 *  expensive insert stage, not a DB-stage failure. */
function assertDimension(modelId: string, embeddings: number[][]): void {
  for (const embedding of embeddings) {
    if (embedding.length !== VECTOR_DIM) {
      throw new Error(
        `Ollama embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${VECTOR_DIM} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

export const ollamaEmbeddingService: EmbeddingService = {
  async embed(value: string): Promise<number[]> {
    const model = getOllamaEmbeddingModel();
    const embeddings = await embedBatchWithModel([value], model);
    assertDimension(model.modelId, embeddings);
    return embeddings[0] ?? [];
  },

  async embedBatch(values: string[]): Promise<number[][]> {
    const model = getOllamaEmbeddingModel();
    const embeddings = await embedBatchWithModel(values, model);
    assertDimension(model.modelId, embeddings);
    return embeddings;
  },
};

registerEmbeddingProvider('ollama', ollamaEmbeddingService);
registerEmbeddingModelIdProvider('ollama', getOllamaEmbeddingModelId);
