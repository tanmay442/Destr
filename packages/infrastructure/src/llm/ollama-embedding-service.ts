import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { resolveVectorDim } from '../db/schema-vector';
import { embedBatchWithModel } from './embedding-batch-helper';
import { registerEmbeddingProvider, registerEmbeddingModelIdProvider, type EmbeddingServiceDeps } from './registries';

export function getOllamaEmbeddingModelId(env: EnvSource = defaultProcessEnv): string {
  return env.get('OLLAMA_EMBEDDING_MODEL') || 'embeddinggemma:latest';
}

function getOllamaEmbeddingModel(env: EnvSource): EmbeddingModelV3 {
  const baseURL = env.get('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  return provider.textEmbedding(getOllamaEmbeddingModelId(env)) as EmbeddingModelV3;
}

function assertDimension(modelId: string, embeddings: number[][], vectorDim: number): void {
  for (const embedding of embeddings) {
    if (embedding.length !== vectorDim) {
      throw new Error(
        `Ollama embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${vectorDim} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

export function createOllamaEmbeddingService(deps: EmbeddingServiceDeps): EmbeddingService {
  const vectorDim = deps.vectorDim ?? resolveVectorDim(deps.env);
  const env = deps.env;
  return {
    async embed(value: string, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
      const model = getOllamaEmbeddingModel(env);
      const embeddings = await embedBatchWithModel([value], model, undefined, opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings[0] ?? [];
    },

    async embedBatch(values: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
      const model = getOllamaEmbeddingModel(env);
      const embeddings = await embedBatchWithModel(values, model, undefined, opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings;
    },
  };
}

registerEmbeddingProvider('ollama', (deps) => createOllamaEmbeddingService(deps));
registerEmbeddingModelIdProvider('ollama', (deps) => getOllamaEmbeddingModelId(deps.env));
