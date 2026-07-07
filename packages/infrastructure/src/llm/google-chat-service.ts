// Google AI Studio chat adapter for users who want Google for both
// embedding and chat.
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV3 } from '@ai-sdk/provider';

export function getGoogleChatModel(): LanguageModelV3 {
  const apiKey = process.env.AI_STUDIO_KEY;
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google.chat('gemini-1.5-flash') as LanguageModelV3;
}
