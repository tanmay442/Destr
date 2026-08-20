import { getEmbeddingModel, EMBEDDING_OPTIONS } from './google-embedding-service';
import type { EmbeddingService } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';
import { registerEmbeddingProvider } from './registries';

export const googleEmbeddingService: EmbeddingService = {
  async embed(value: string): Promise<number[]> {
    const embeddings = await embedBatchWithModel([value], getEmbeddingModel(), {
      google: EMBEDDING_OPTIONS,
    });
    return embeddings[0] ?? [];
  },

  async embedBatch(values: string[]): Promise<number[][]> {
    return embedBatchWithModel(values, getEmbeddingModel(), { google: EMBEDDING_OPTIONS });
  },
};

registerEmbeddingProvider('google', googleEmbeddingService);
