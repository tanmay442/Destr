import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getGoogleChatModelId(): string {
  return process.env.GOOGLE_CHAT_MODEL ?? 'gemini-2.5-flash';
}

export function getGoogleChatModel(modelId?: string): LanguageModelV3 {
  const apiKey = process.env.AI_STUDIO_KEY;
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google.chat(modelId ?? getGoogleChatModelId()) as LanguageModelV3;
}
