import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { getOpenAIOperationPath, normalizeOpenAIBaseURL } from './openai-base-url';
import { registerChatProvider, registerChatProviderAdapter } from './registries';
import {
  OPENAI_PROMPT_CACHE_CAPABILITIES,
  buildOpenAIPromptCacheOptions,
  parsePromptCacheUsage,
} from './prompt-cache';

export function getOpenAIChatModel(modelId?: string, env: EnvSource = defaultProcessEnv): LanguageModelV3 {
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

registerChatProvider('openai', (deps) => getOpenAIChatModel(deps.modelId, deps.env));
registerChatProviderAdapter('openai', {
  capabilities: OPENAI_PROMPT_CACHE_CAPABILITIES,
  buildProviderOptions: buildOpenAIPromptCacheOptions,
  toolCapabilities: { strictSchemas: 'native', inputExamples: 'native', outputSchemas: 'validated_locally', parallelCalls: true, toolCallRepair: 'unsupported', approvalHooks: 'application' },
  parseUsage: (usage, providerMetadata) => parsePromptCacheUsage('openai', usage, providerMetadata),
});
