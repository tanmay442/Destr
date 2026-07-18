import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getOllamaChatModel(modelId?: string): LanguageModelV3 {
  const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  const resolved = modelId ?? process.env.OLLAMA_CHAT_MODEL ?? 'gemma2:2b';
  return provider.chat(resolved) as LanguageModelV3;
}
