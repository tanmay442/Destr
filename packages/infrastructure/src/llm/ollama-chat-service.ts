import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { registerChatProvider, registerChatProviderAdapter } from './registries';
import { OLLAMA_PROMPT_CACHE_CAPABILITIES, parsePromptCacheUsage } from './prompt-cache';

export function getOllamaChatModel(modelId?: string, env: EnvSource = defaultProcessEnv): LanguageModelV3 {
  const baseURL = env.get('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  const resolved = modelId ?? env.get('OLLAMA_CHAT_MODEL') ?? 'gemma4:e2b';
  return provider.chat(resolved) as LanguageModelV3;
}

registerChatProvider('ollama', (deps) => getOllamaChatModel(deps.modelId, deps.env));
registerChatProviderAdapter('ollama', {
  capabilities: OLLAMA_PROMPT_CACHE_CAPABILITIES,
  parseUsage: (usage, providerMetadata) => parsePromptCacheUsage('ollama', usage, providerMetadata),
});
