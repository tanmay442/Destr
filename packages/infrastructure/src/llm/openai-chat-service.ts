import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getChatModel(): LanguageModelV3 {
  const apiKey = process.env.CUSTOM_LLM_API_KEY;
  const baseURL = process.env.CUSTOM_LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL must be set.');
  }
  const provider = createOpenAI({ apiKey, baseURL });
  const modelId = process.env.LLM_MODEL || 'custom-chat-model';
  return provider.chat(modelId) as LanguageModelV3;
}
