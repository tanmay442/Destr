import type { EmbeddingService, Reranker } from '@app/domain';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createProviderRegistry } from '../registry';

export type ChatModelProvider = (modelId?: string) => LanguageModelV3;

export const chatProviderRegistry = createProviderRegistry<ChatModelProvider>();

export function registerChatProvider(key: string, factory: ChatModelProvider): void {
  chatProviderRegistry.register(key, factory);
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
