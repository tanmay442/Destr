import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import type { EmbeddingService, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { resolveVectorDim } from '../db/schema-vector';
import { embedBatchWithModel } from './embedding-batch-helper';
import { normalizeOpenAIBaseURL } from './openai-base-url';
import { registerEmbeddingProvider, registerEmbeddingModelIdProvider, type EmbeddingServiceDeps } from './registries';

export function getOpenAIEmbeddingModelId(env: EnvSource = defaultProcessEnv): string {
  return env.get('OPENAI_EMBEDDING_MODEL') || 'text-embedding-3-small';
}

function getOpenAIEmbeddingModel(env: EnvSource): EmbeddingModelV3 {
  const apiKey = env.get('OPENAI_EMBEDDING_API_KEY') ?? env.get('CUSTOM_LLM_API_KEY');
  const baseURL = env.get('OPENAI_EMBEDDING_BASE_URL') ?? env.get('CUSTOM_LLM_BASE_URL');
  if (!apiKey || !baseURL) {
    throw new Error(
      'OPENAI_EMBEDDING_API_KEY and OPENAI_EMBEDDING_BASE_URL must be set (or CUSTOM_LLM_API_KEY/CUSTOM_LLM_BASE_URL).',
    );
  }
  const provider = createOpenAI({ apiKey, baseURL: normalizeOpenAIBaseURL(baseURL) });
  return provider.textEmbedding(getOpenAIEmbeddingModelId(env)) as EmbeddingModelV3;
}

function getOpenAIEmbeddingOptions(vectorDim: number) {
  return {
    openai: {
      dimensions: vectorDim,
    },
  } as const;
}

function assertDimension(modelId: string, embeddings: number[][], vectorDim: number): void {
  for (const embedding of embeddings) {
    if (embedding.length !== vectorDim) {
      throw new Error(
        `OpenAI embedding model "${modelId}" returned ${embedding.length}-dimension vectors, but ` +
          `EMBEDDING_DIMENSION=${vectorDim} (vector column width). Set EMBEDDING_DIMENSION=${embedding.length} ` +
          'or switch to a model that emits vectors of the expected width.',
      );
    }
  }
}

export function createOpenAIEmbeddingService(deps: EmbeddingServiceDeps): EmbeddingService {
  const vectorDim = deps.vectorDim ?? resolveVectorDim(deps.env);
  const env = deps.env;
  const getProviderOptions = () => getOpenAIEmbeddingOptions(vectorDim);
  return {
    async embed(value: string, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
      const model = getOpenAIEmbeddingModel(env);
      const embeddings = await embedBatchWithModel([value], model, getProviderOptions(), opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings[0] ?? [];
    },

    async embedBatch(values: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
      const model = getOpenAIEmbeddingModel(env);
      const embeddings = await embedBatchWithModel(values, model, getProviderOptions(), opts);
      assertDimension(model.modelId, embeddings, vectorDim);
      return embeddings;
    },
  };
}

registerEmbeddingProvider('openai', (deps) => createOpenAIEmbeddingService(deps));
registerEmbeddingModelIdProvider('openai', (deps) => getOpenAIEmbeddingModelId(deps.env));
