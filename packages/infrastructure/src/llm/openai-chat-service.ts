import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { normalizeOpenAIBaseURL } from './openai-base-url';
import { registerChatProvider } from './registries';

export function getChatModel(modelId?: string): LanguageModelV3 {
  const apiKey = process.env.CUSTOM_LLM_API_KEY;
  const baseURL = process.env.CUSTOM_LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL must be set.');
  }
  const resolved = modelId ?? process.env.LLM_MODEL;
  if (!resolved) {
    throw new Error('LLM_MODEL must be set (or pass an explicit model id) when CHAT_PROVIDER=openai.');
  }
  const provider = createOpenAI({ apiKey, baseURL: normalizeOpenAIBaseURL(baseURL) });
  return provider.chat(resolved) as LanguageModelV3;
}

registerChatProvider('openai', getChatModel);
