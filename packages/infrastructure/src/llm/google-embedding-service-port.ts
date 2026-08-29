import { getEmbeddingModel, getGoogleEmbeddingOptions } from './google-embedding-service';
import { resolveVectorDim } from '../db/schema-vector';
import type { EmbeddingService } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';
import { registerEmbeddingProvider } from './registries';

function assertDimension(modelId: string, embeddings: number[][], vectorDim?: number): void {
  const expectedDimension = vectorDim ?? resolveVectorDim();
  for (const embedding of embeddings) {
    if (embedding.length !== expectedDimension) {
      throw new Error(
        `Google embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${expectedDimension} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

function createGoogleEmbeddingService(vectorDim?: number): EmbeddingService {
  const getProviderOptions = () => ({ google: getGoogleEmbeddingOptions(vectorDim) });
  return {
    async embed(value: string): Promise<number[]> {
      const model = getEmbeddingModel();
      const embeddings = await embedBatchWithModel([value], model, getProviderOptions());
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings[0] ?? [];
    },

    async embedBatch(values: string[]): Promise<number[][]> {
      const model = getEmbeddingModel();
      const embeddings = await embedBatchWithModel(values, model, getProviderOptions());
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings;
    },
  };
}

export const googleEmbeddingService = createGoogleEmbeddingService();

registerEmbeddingProvider('google', (vectorDim) =>
  vectorDim === undefined ? googleEmbeddingService : createGoogleEmbeddingService(vectorDim),
);
