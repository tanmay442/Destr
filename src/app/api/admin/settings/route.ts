import { requireAdminRoute } from '@/composition';
import { appConfig } from '@/lib/config';

const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? 'google';

function resolveEmbeddingModelId(): string {
  switch (EMBEDDING_PROVIDER) {
    case 'google':
      return 'gemini-embedding-001';
    case 'openai':
      return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    case 'ollama':
      return process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    default:
      return 'unknown';
  }
}

const CHUNKING_STRATEGIES = [
  'document-aware',
  'recursive-adaptive',
  'semantic',
  'parent-child',
] as const;

export async function GET() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;
  return Response.json({
    chunkingStrategy: appConfig.chunkingStrategy,
    chunkingStrategies: CHUNKING_STRATEGIES,
    embeddingModel: resolveEmbeddingModelId(),
    envDriven: true,
    parentChunkSize: appConfig.parentChunkSize,
    childChunkSize: appConfig.childChunkSize,
  });
}
