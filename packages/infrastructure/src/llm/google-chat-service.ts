import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getGoogleChatModel(modelId?: string): LanguageModelV3 {
  const apiKey = process.env.AI_STUDIO_KEY;
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google.chat(modelId ?? 'gemini-1.5-flash') as LanguageModelV3;
}
