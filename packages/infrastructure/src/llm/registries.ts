import type { EmbeddingService, Reranker } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createProviderRegistry } from '../registry';

export type ChatModelProvider = (modelId?: string) => LanguageModelV3;

export const chatProviderRegistry = createProviderRegistry<ChatModelProvider>();

export function registerChatProvider(key: string, factory: ChatModelProvider): void {
  chatProviderRegistry.register(key, factory);
}

export const embeddingProviderRegistry = createProviderRegistry<EmbeddingService>();

export function registerEmbeddingProvider(key: string, provider: EmbeddingService): void {
  embeddingProviderRegistry.register(key, provider);
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