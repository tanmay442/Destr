import type { LanguageModelV3 } from '@ai-sdk/provider';
import {
  chatProviderAdapterRegistry,
  chatProviderRegistry,
  type ChatModelProviderAdapter,
} from './registries';
import type { PromptCacheRequestContext, PromptCacheUsage } from './prompt-cache';

export interface ChatModelAdapter {
  readonly model: LanguageModelV3;
  /** Stable configured provider key, retained inside infrastructure. */
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: ChatModelProviderAdapter['capabilities'];
  readonly buildProviderOptions: (
    context: PromptCacheRequestContext,
  ) => ReturnType<NonNullable<ChatModelProviderAdapter['buildProviderOptions']>>;
  readonly parseUsage: (usage: unknown, providerMetadata?: unknown) => PromptCacheUsage;
}

function resolveProvider(): {
  name: string;
  factory: NonNullable<ReturnType<typeof chatProviderRegistry.get>>;
  adapter: ChatModelProviderAdapter | undefined;
} {
  const name = process.env.CHAT_PROVIDER ?? 'openai';
  const factory = chatProviderRegistry.get(name);
  if (!factory) throw new Error(`Unknown CHAT_PROVIDER: ${name}`);
  return { name, factory, adapter: chatProviderAdapterRegistry.get(name) };
}

function noProviderOptions(): undefined {
  return undefined;
}

export function getChatModel(modelId?: string): LanguageModelV3 {
  return getChatModelAdapter(modelId).model;
}

/**
 * Resolve the model together with the provider capability adapter. The
 * adapter is the only place that knows how a vendor expresses prompt-cache
 * controls or usage details.
 */
export function getChatModelAdapter(modelId?: string): ChatModelAdapter {
  const resolved = resolveProvider();
  const model = resolved.factory(modelId);
  const adapter = resolved.adapter;
  return {
    model,
    provider: resolved.name,
    modelId: model.modelId,
    capabilities: adapter?.capabilities ?? {
      strategy: 'none',
      automatic: false,
      explicit: false,
      telemetry: false,
    },
    buildProviderOptions: adapter?.buildProviderOptions ?? noProviderOptions,
    parseUsage: adapter?.parseUsage ?? (() => ({
      inputTokens: null,
      inputTokensStatus: 'unsupported' as const,
      cachedInputTokens: null,
      cachedInputTokensStatus: 'unsupported' as const,
      cacheReadTokens: null,
      cacheReadStatus: 'unsupported' as const,
      cacheWriteTokens: null,
      cacheWriteStatus: 'unsupported' as const,
      cacheHitRatio: null,
    })),
  };
}

export function getChatModelCapabilities(modelId?: string): ChatModelAdapter['capabilities'] {
  return getChatModelAdapter(modelId).capabilities;
}

export function getChatModelProviderOptions(
  context: PromptCacheRequestContext,
  modelId?: string,
): ReturnType<ChatModelAdapter['buildProviderOptions']> {
  return getChatModelAdapter(modelId).buildProviderOptions(context);
}

export function getChatModelTelemetry(modelId?: string): {
  provider: string;
  model: string;
  capabilities: ChatModelAdapter['capabilities'];
} {
  const adapter = getChatModelAdapter(modelId);
  return {
    provider: adapter.provider,
    model: adapter.modelId,
    capabilities: adapter.capabilities,
  };
}

export function parseChatModelUsage(
  usage: unknown,
  providerMetadata?: unknown,
  modelId?: string,
): PromptCacheUsage {
  return getChatModelAdapter(modelId).parseUsage(usage, providerMetadata);
}
