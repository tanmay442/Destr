import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { EnvSource, ProviderToolCapabilities } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import {
  getOpenAIOperationPath,
  isNativeOpenAIBaseURL,
  normalizeOpenAIBaseURL,
} from './openai-base-url';
import { registerChatProvider, registerChatProviderAdapter } from './registries';
import {
  buildOpenAIPromptCacheOptions,
  getOpenAIPromptCacheCapabilities,
  parsePromptCacheUsage,
} from './prompt-cache';

export function getOpenAIChatModel(modelId?: string, env: EnvSource = defaultProcessEnv): LanguageModelV4 {
  const apiKey = env.get('CUSTOM_LLM_API_KEY');
  const baseURL = env.get('CUSTOM_LLM_BASE_URL');
  if (!apiKey || !baseURL) {
    throw new Error('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL must be set.');
  }
  const resolved = modelId ?? env.get('LLM_MODEL');
  if (!resolved) {
    throw new Error('LLM_MODEL must be set (or pass an explicit model id) when CHAT_PROVIDER=openai.');
  }
  const provider = createOpenAI({ apiKey, baseURL: normalizeOpenAIBaseURL(baseURL) });
  return getOpenAIOperationPath(baseURL) === '/responses'
    ? provider.responses(resolved)
    : provider.chat(resolved);
}

const NATIVE_OPENAI_TOOL_CAPABILITIES: ProviderToolCapabilities = Object.freeze({
  strictSchemas: 'native',
  inputExamples: 'native',
  outputSchemas: 'validated_locally',
  parallelCalls: true,
  toolCallRepair: 'unsupported',
  approvalHooks: 'application',
});

const COMPATIBLE_API_TOOL_CAPABILITIES: ProviderToolCapabilities = Object.freeze({
  // Compatible APIs such as Groq can impose a different strict JSON Schema
  // subset. Keep the application's authoritative local Zod validation while
  // asking the provider for best-effort arguments (`strict: false`).
  strictSchemas: 'emulated',
  inputExamples: 'description_middleware',
  outputSchemas: 'validated_locally',
  parallelCalls: true,
  toolCallRepair: 'unsupported',
  approvalHooks: 'application',
});

export function getOpenAIToolCapabilities(
  env: EnvSource = defaultProcessEnv,
): ProviderToolCapabilities {
  return isNativeOpenAIBaseURL(env.get('CUSTOM_LLM_BASE_URL'))
    ? NATIVE_OPENAI_TOOL_CAPABILITIES
    : COMPATIBLE_API_TOOL_CAPABILITIES;
}

registerChatProvider('openai', (deps) => getOpenAIChatModel(deps.modelId, deps.env));
registerChatProviderAdapter('openai', {
  capabilities: getOpenAIPromptCacheCapabilities,
  buildProviderOptions: buildOpenAIPromptCacheOptions,
  toolCapabilities: getOpenAIToolCapabilities,
  parseUsage: (usage, providerMetadata) => parsePromptCacheUsage('openai', usage, providerMetadata),
});
