import type { EmbeddingService, Reranker } from '@app/domain';
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider';
import { createProviderRegistry } from '../registry';
import type {
  PromptCacheCapabilities,
  PromptCacheRequestContext,
  PromptCacheUsage,
} from './prompt-cache';

export type ChatModelProvider = (modelId?: string) => LanguageModelV3;

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

export type EmbeddingProviderFactory = (vectorDim?: number) => EmbeddingService;

export const embeddingProviderRegistry = createProviderRegistry<EmbeddingProviderFactory>();

export function registerEmbeddingProvider(key: string, factory: EmbeddingProviderFactory): void {
  embeddingProviderRegistry.register(key, factory);
}

export type RerankerProvider = () => Reranker | undefined;

export const rerankerProviderRegistry = createProviderRegistry<RerankerProvider>();

export function registerRerankerProvider(key: string, factory: RerankerProvider): void {
  rerankerProviderRegistry.register(key, factory);
}

export const embeddingModelIdRegistry = createProviderRegistry<() => string>();

export function registerEmbeddingModelIdProvider(key: string, factory: () => string): void {
  embeddingModelIdRegistry.register(key, factory);
}
