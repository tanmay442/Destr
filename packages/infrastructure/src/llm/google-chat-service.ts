import { createGoogle } from '@ai-sdk/google';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { registerChatProvider, registerChatProviderAdapter } from './registries';
import {
  GOOGLE_PROMPT_CACHE_CAPABILITIES,
  buildGooglePromptCacheOptions,
  parsePromptCacheUsage,
} from './prompt-cache';

export function getGoogleChatModelId(env: EnvSource = defaultProcessEnv): string {
  return env.get('GOOGLE_CHAT_MODEL') ?? 'gemini-2.5-flash';
}

export function getGoogleChatModel(modelId?: string, env: EnvSource = defaultProcessEnv): LanguageModelV4 {
  const apiKey = env.get('AI_STUDIO_KEY');
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogle({ apiKey });
  return google.chat(modelId ?? getGoogleChatModelId(env));
}

registerChatProvider('google', (deps) => getGoogleChatModel(deps.modelId, deps.env));
registerChatProviderAdapter('google', {
  capabilities: GOOGLE_PROMPT_CACHE_CAPABILITIES,
  buildProviderOptions: (context, env) =>
    buildGooglePromptCacheOptions(context, env.get('GOOGLE_CACHED_CONTENT')),
  toolCapabilities: { strictSchemas: 'native', inputExamples: 'description_middleware', outputSchemas: 'validated_locally', parallelCalls: true, toolCallRepair: 'unsupported', approvalHooks: 'application' },
  parseUsage: (usage, providerMetadata) => parsePromptCacheUsage('google', usage, providerMetadata),
});
