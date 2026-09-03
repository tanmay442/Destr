import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import {
  chatProviderAdapterRegistry,
  chatProviderRegistry,
  type ChatModelDeps,
  type ChatModelProvider,
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

function resolveProvider(env: EnvSource = defaultProcessEnv): {
  name: string;
  factory: NonNullable<ReturnType<typeof chatProviderRegistry.get>>;
  adapter: ChatModelProviderAdapter | undefined;
} {
  const name = env.get('CHAT_PROVIDER') ?? 'openai';
  const factory = chatProviderRegistry.get(name);
  if (!factory) throw new Error(`Unknown CHAT_PROVIDER: ${name}`);
  return { name, factory, adapter: chatProviderAdapterRegistry.get(name) };
}

export const defaultChatModelProvider: ChatModelProvider = (deps: ChatModelDeps) =>
  getChatModel(deps.modelId, deps.env);

function noProviderOptions(): undefined {
  return undefined;
}

export function getChatModel(modelId?: string, env: EnvSource = defaultProcessEnv): LanguageModelV3 {
  return getChatModelAdapter(modelId, env).model;
}

/**
 * Resolve the model together with the provider capability adapter. The
 * adapter is the only place that knows how a vendor expresses prompt-cache
 * controls or usage details.
 */
export function getChatModelAdapter(modelId?: string, env: EnvSource = defaultProcessEnv): ChatModelAdapter {
  const resolved = resolveProvider(env);
  const model = resolved.factory({ env, ...(modelId !== undefined ? { modelId } : {}) });
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

export function getChatModelCapabilities(modelId?: string, env: EnvSource = defaultProcessEnv): ChatModelAdapter['capabilities'] {
  return getChatModelAdapter(modelId, env).capabilities;
}

export function getChatModelProviderOptions(
  context: PromptCacheRequestContext,
  modelId?: string,
  env: EnvSource = defaultProcessEnv,
): ReturnType<ChatModelAdapter['buildProviderOptions']> {
  return getChatModelAdapter(modelId, env).buildProviderOptions(context);
}

export function getChatModelTelemetry(modelId?: string, env: EnvSource = defaultProcessEnv): {
  provider: string;
  model: string;
  capabilities: ChatModelAdapter['capabilities'];
} {
  const adapter = getChatModelAdapter(modelId, env);
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
  env: EnvSource = defaultProcessEnv,
): PromptCacheUsage {
  return getChatModelAdapter(modelId, env).parseUsage(usage, providerMetadata);
}
