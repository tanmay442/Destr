import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { resolveVectorDim } from '../db/schema-vector';
import { embedBatchWithModel } from './embedding-batch-helper';
import { registerEmbeddingProvider, registerEmbeddingModelIdProvider, type EmbeddingServiceDeps } from './registries';

export function getGoogleEmbeddingModelId(env: EnvSource = defaultProcessEnv): string {
  return env.get('GOOGLE_EMBEDDING_MODEL') ?? 'gemini-embedding-001';
}

export function getEmbeddingModel(env: EnvSource = defaultProcessEnv): EmbeddingModelV3 {
  const apiKey = env.get('AI_STUDIO_KEY');
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google.textEmbedding(getGoogleEmbeddingModelId(env)) as EmbeddingModelV3;
}

export function getGoogleEmbeddingOptions(vectorDim?: number, env: EnvSource = defaultProcessEnv) {
  return {
    outputDimensionality: vectorDim ?? resolveVectorDim(env),
  } as const;
}

export const EMBEDDING_OPTIONS = {
  get outputDimensionality(): number {
    return resolveVectorDim();
  },
};

function assertDimension(modelId: string, embeddings: number[][], vectorDim: number): void {
  for (const embedding of embeddings) {
    if (embedding.length !== vectorDim) {
      throw new Error(
        `Google embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${vectorDim} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

export function createGoogleEmbeddingService(deps: EmbeddingServiceDeps): EmbeddingService {
  const vectorDim = deps.vectorDim ?? resolveVectorDim(deps.env);
  const env = deps.env;
  const getProviderOptions = () => ({ google: getGoogleEmbeddingOptions(vectorDim) });
  return {
    async embed(value: string, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
      const model = getEmbeddingModel(env);
      const embeddings = await embedBatchWithModel([value], model, getProviderOptions(), opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings[0] ?? [];
    },

    async embedBatch(values: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
      const model = getEmbeddingModel(env);
      const embeddings = await embedBatchWithModel(values, model, getProviderOptions(), opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings;
    },
  };
}

registerEmbeddingProvider('google', (deps) => createGoogleEmbeddingService(deps));
registerEmbeddingModelIdProvider('google', (deps) => getGoogleEmbeddingModelId(deps.env));
