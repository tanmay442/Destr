import { embed } from 'ai';
import { getEmbeddingModel, EMBEDDING_OPTIONS } from './google-embedding-service';
import type { EmbeddingService } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';

export const googleEmbeddingService: EmbeddingService = {
  async embed(value: string): Promise<number[]> {
    const { embedding } = await embed({
      model: getEmbeddingModel(),
      value,
      providerOptions: { google: EMBEDDING_OPTIONS },
    });
    return embedding;
  },

  async embedBatch(values: string[]): Promise<number[][]> {
    return embedBatchWithModel(values, getEmbeddingModel(), { google: EMBEDDING_OPTIONS });
  },
};
