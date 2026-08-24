import type { LanguageModelV3 } from '@ai-sdk/provider';
import { chatProviderRegistry } from './registries';

export function getChatModel(modelId?: string): LanguageModelV3 {
  const provider = process.env.CHAT_PROVIDER ?? 'openai';
  const factory = chatProviderRegistry.get(provider);
  if (!factory) throw new Error(`Unknown CHAT_PROVIDER: ${provider}`);
  return factory(modelId);
}
