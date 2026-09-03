import type {
  EmbeddingService,
  EnvSource,
  Reranker,
  QueryRewriter,
  HallucinationGrader,
} from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { resolveVectorDim } from '../db/schema-vector';
import './openai-chat-service';
import './google-chat-service';
import './ollama-chat-service';
import './google-embedding-service';
import './openai-embedding-service';
import './ollama-embedding-service';
import { docSummarizer, createDocSummarizer } from './doc-summarizer';
import { localReranker, checkLocalRerankerAvailable } from './local-reranker';
import { cohereReranker } from './cohere-reranker';
import { createAuxModels } from './aux';
import {
  embeddingProviderRegistry,
  rerankerProviderRegistry,
  embeddingModelIdRegistry,
  registerRerankerProvider,
  type ChatModelDeps,
  type ChatModelProvider,
  type EmbeddingModelIdDeps,
  type EmbeddingServiceDeps,
  type RerankerDeps,
} from './registries';
import { defaultChatModelProvider } from './model';

export type {
  ChatModelDeps,
  ChatModelProvider,
  EmbeddingModelIdDeps,
  EmbeddingServiceDeps,
  RerankerDeps,
};

export {
  getChatModel,
  getChatModelAdapter,
  getChatModelCapabilities,
  getChatModelProviderOptions,
  getChatModelTelemetry,
  parseChatModelUsage,
  defaultChatModelProvider,
  type ChatModelAdapter,
} from './model';
export {
  OPENAI_PROMPT_CACHE_CAPABILITIES,
  GOOGLE_PROMPT_CACHE_CAPABILITIES,
  OLLAMA_PROMPT_CACHE_CAPABILITIES,
  buildOpenAIPromptCacheOptions,
  buildGooglePromptCacheOptions,
  parsePromptCacheUsage,
  type PromptCacheCapabilities,
  type PromptCacheMetricStatus,
  type PromptCacheRequestContext,
  type PromptCacheStrategy,
  type PromptCacheUsage,
} from './prompt-cache';
export {
  EMBEDDING_RETRY_BUDGET_MS,
  createRetryBudget,
  isRetryBudgetExceeded,
  RetryBudgetExceededError,
  type RetryBudget,
} from './retry';

export function getEmbeddingService(vectorDim?: number, env: EnvSource = defaultProcessEnv): EmbeddingService {
  const provider = env.get('EMBEDDING_PROVIDER') ?? 'google';
  const factory = embeddingProviderRegistry.get(provider);
  if (!factory) throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  return factory({ env, vectorDim: vectorDim ?? resolveVectorDim(env) });
}

export interface RerankerPlatform {
  isServerless: boolean;
}

export function resolveRerankerPlatform(env: EnvSource = defaultProcessEnv): RerankerPlatform {
  const vercel = env.get('VERCEL');
  return { isServerless: vercel !== undefined && vercel !== '' };
}

export function getReranker(provider?: string, env: EnvSource = defaultProcessEnv): Reranker | undefined {
  const selected = provider ?? env.get('RERANKER_PROVIDER') ?? 'cosine';
  const factory = rerankerProviderRegistry.get(selected);
  if (!factory) return undefined;
  return factory({ env });
}

registerRerankerProvider('cosine', () => undefined);

export type RerankerStatus = { ok: boolean; reason?: string | undefined };

export interface RerankerAvailability {
  reranker?: Reranker | undefined;
  status: RerankerStatus;
}

const rerankerOverrides = new Map<string, RerankerAvailability>();

function getRerankerRegistry(
  env: EnvSource = defaultProcessEnv,
  platform?: RerankerPlatform,
): Map<string, RerankerAvailability> {
  const resolvedPlatform = platform ?? resolveRerankerPlatform(env);
  const base = new Map<string, RerankerAvailability>([
    ['cosine', { reranker: undefined, status: { ok: true } }],
    [
      'cohere',
      env.get('COHERE_API_KEY')
        ? { reranker: getReranker('cohere', env), status: { ok: true } }
        : { reranker: undefined, status: { ok: false, reason: 'COHERE_API_KEY not set' } },
    ],
    [
      'local',
      resolvedPlatform.isServerless
        ? { reranker: undefined, status: { ok: false, reason: 'local reranker unavailable on Vercel serverless' } }
        : { reranker: getReranker('local', env), status: { ok: true } },
    ],
  ]);
  for (const [k, v] of rerankerOverrides) base.set(k, v);
  return base;
}

export function availableRerankers(
  env: EnvSource = defaultProcessEnv,
  platform?: RerankerPlatform,
): Map<string, RerankerStatus> {
  return new Map([...getRerankerRegistry(env, platform)].map(([name, entry]) => [name, entry.status]));
}

export function resolveReranker(
  provider: string,
  env: EnvSource = defaultProcessEnv,
  platform?: RerankerPlatform,
): Reranker | undefined {
  return getRerankerRegistry(env, platform).get(provider)?.reranker;
}

export function updateRerankerAvailability(provider: string, availability: RerankerAvailability): void {
  rerankerOverrides.set(provider, availability);
}

export function getAuxModels(
  enabled?: boolean,
  auxModelId?: string,
  modelProvider: ChatModelProvider = defaultChatModelProvider,
  env: EnvSource = defaultProcessEnv,
): {
  queryRewriter: QueryRewriter | undefined;
  hallucinationGrader: HallucinationGrader | undefined;
} {
  const on = enabled ?? env.get('AGENTIC_ENABLED') !== 'false';
  if (!on) {
    return {
      queryRewriter: undefined,
      hallucinationGrader: undefined,
    };
  }
  const aux = createAuxModels(auxModelId, modelProvider);
  return {
    queryRewriter: aux.queryRewriter,
    hallucinationGrader: aux.hallucinationGrader,
  };
}

export { getEmbeddingModel, getGoogleEmbeddingOptions, EMBEDDING_OPTIONS, getGoogleEmbeddingModelId } from './google-embedding-service';
export {
  docSummarizer,
  createDocSummarizer,
  localReranker,
  checkLocalRerankerAvailable,
  cohereReranker,
  createAuxModels,
};
export { judgeRelevance, judgeFaithfulness } from './judge';

/** Resolve the embedding model id string for the active provider.
 *  Used to stamp `DocumentChunk.embeddingModel` metadata. */
export function getEmbeddingModelId(env: EnvSource = defaultProcessEnv): string {
  const provider = env.get('EMBEDDING_PROVIDER') ?? 'google';
  const factory = embeddingModelIdRegistry.get(provider);
  if (!factory) return 'unknown';
  return factory({ env });
}
