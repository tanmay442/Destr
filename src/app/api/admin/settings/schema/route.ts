import { requireAdminRoute } from '@/composition';
import { getRuntimeConfig, envLockedPaths } from '@/lib/config/runtime';
import { buildDescriptor, resolveEmbeddingModelId } from '../descriptor';

export async function GET() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;

  const [cfg, { overrides }] = await Promise.all([
    getRuntimeConfig(),
    auth.comp.settingsRepo.getOverrides(),
  ]);

  const fields = buildDescriptor({
    cfg,
    overrides,
    lockedPaths: envLockedPaths(),
    rerankers: auth.comp.availableRerankers(),
    embeddingModel: resolveEmbeddingModelId(),
  });

  return Response.json({ fields });
}
