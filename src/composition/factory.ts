import { Db, Llm, Auth, answerCacheKey } from '@app/infrastructure';
import {
  core,
  modelGateway, blobStorage, rateLimiter,
  cacheLeasePolicy, onCacheLeaseTelemetry,
  settingsRepo, chatEventBatcher, chatFeedbackRepo, qualityReviewsRepo, chatHistoryRepo,
} from './infra';
import { buildRagOps } from './rag';
import { buildChatOps } from './chat';
import { buildAdminOps } from './admin';

export function createComposition() {
  return {
    ...buildRagOps(),
    ...buildChatOps(),
    ...buildAdminOps(),
    db: core.dbClient,
    schema: Db.schema,
    blobStorage,
    modelGateway,
    getEmbeddingModel: () => Llm.getEmbeddingModel(core.env),
    getChatModel: (modelId?: string) => Llm.getChatModel(modelId, core.env),
    allowedChatFileOrigins: new Set(
      (process.env.CHAT_FILE_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
    getChatModelRequestOptions: (input: { stablePromptPrefix: string; prefixVersion: string }) => {
      const adapter = Llm.getChatModelAdapter(undefined, core.env);
      const providerOptions = adapter.buildProviderOptions(input);
      return {
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        telemetry: {
          provider: adapter.provider,
          model: adapter.modelId,
          promptPrefixVersion: input.prefixVersion,
          promptCache: { ...adapter.capabilities },
        },
        parseUsage: adapter.parseUsage,
      };
    },
    getRetrievalProvider: () => 'pgvector',
    getEmbeddingModelId: () => core.embeddingModelId,
    answerCacheKey,
    cacheLeasePolicy,
    onCacheLeaseTelemetry,
    answerCache: core.answerCache,
    turnResultCache: core.answerCache,
    settingsRepo,
    chatEventBatcher,
    chatFeedbackRepo,
    qualityReviewsRepo,
    chatHistoryRepo,
    session: Auth.clerkSessionStore,
    rateLimit: (key: string, opts: { limit: number; windowMs: number }) =>
      rateLimiter.check(key, opts),
  };
}

export type Composition = ReturnType<typeof createComposition>;
