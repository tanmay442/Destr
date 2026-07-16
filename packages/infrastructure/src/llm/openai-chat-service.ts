import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getChatModel(modelId?: string): LanguageModelV3 {
  const apiKey = process.env.CUSTOM_LLM_API_KEY;
  const baseURL = process.env.CUSTOM_LLM_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error('CUSTOM_LLM_API_KEY and CUSTOM_LLM_BASE_URL must be set.');
  }
  // Normalize base URL: the SDK appends /chat/completions, so strip any
  // trailing path beyond /v1 (e.g., /v1/responses) to avoid double-pathing.
  const normalizedBaseURL = baseURL.replace(/\/v1\/?.+$/, '/v1');
  const provider = createOpenAI({ apiKey, baseURL: normalizedBaseURL });
  const resolved = modelId ?? process.env.LLM_MODEL ?? 'custom-chat-model';
  return provider.chat(resolved) as LanguageModelV3;
}
