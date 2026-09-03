import type { EmbeddingService, EnvSource, Reranker } from '@app/domain';
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { createProviderRegistry } from '../registry';
import type {
  PromptCacheCapabilities,
  PromptCacheRequestContext,
  PromptCacheUsage,
} from './prompt-cache';

export interface ChatModelDeps {
  env: EnvSource;
  modelId?: string | undefined;
}

export type ChatModelProvider = (deps: ChatModelDeps) => LanguageModelV3;

export const chatProviderRegistry = createProviderRegistry<ChatModelProvider>();

export function registerChatProvider(key: string, factory: ChatModelProvider): void {
  chatProviderRegistry.register(key, factory);
}

/**
 * Metadata and request behavior owned by a concrete chat model adapter.
 * Callers consume this through the infrastructure composition seam and never
 * need to know which vendor options are supported.
 */
export interface ChatModelProviderAdapter {
  readonly capabilities: PromptCacheCapabilities;
  readonly buildProviderOptions?: (
    context: PromptCacheRequestContext,
  ) => SharedV3ProviderOptions | undefined;
  readonly parseUsage: (usage: unknown, providerMetadata?: unknown) => PromptCacheUsage;
}

export const chatProviderAdapterRegistry = createProviderRegistry<ChatModelProviderAdapter>();

export function registerChatProviderAdapter(
  key: string,
  adapter: ChatModelProviderAdapter,
): void {
  chatProviderAdapterRegistry.register(key, adapter);
}

export interface EmbeddingServiceDeps {
  env: EnvSource;
  vectorDim?: number | undefined;
}

export type EmbeddingProviderFactory = (deps: EmbeddingServiceDeps) => EmbeddingService;

export const embeddingProviderRegistry = createProviderRegistry<EmbeddingProviderFactory>();

export function registerEmbeddingProvider(key: string, factory: EmbeddingProviderFactory): void {
  embeddingProviderRegistry.register(key, factory);
}

export interface RerankerDeps {
  env: EnvSource;
}

export type RerankerProvider = (deps: RerankerDeps) => Reranker | undefined;

export const rerankerProviderRegistry = createProviderRegistry<RerankerProvider>();

export function registerRerankerProvider(key: string, factory: RerankerProvider): void {
  rerankerProviderRegistry.register(key, factory);
}

export interface EmbeddingModelIdDeps {
  env: EnvSource;
}

export const embeddingModelIdRegistry = createProviderRegistry<(deps: EmbeddingModelIdDeps) => string>();

export function registerEmbeddingModelIdProvider(key: string, factory: (deps: EmbeddingModelIdDeps) => string): void {
  embeddingModelIdRegistry.register(key, factory);
}
