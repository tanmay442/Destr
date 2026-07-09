import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getOllamaChatModel(): LanguageModelV3 {
  const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const provider = createOpenAI({ apiKey: 'ollama', baseURL: `${baseURL}/v1` });
  const modelId = process.env.OLLAMA_CHAT_MODEL || 'llama3.1';
  return provider.chat(modelId) as LanguageModelV3;
}
