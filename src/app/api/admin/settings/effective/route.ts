import { requireAdminRoute } from '@/composition';
import { getRuntimeConfig, envLockedPaths } from '@/lib/config/runtime';
import { buildEffective, resolveEmbeddingModelId } from '../descriptor';

export async function GET() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;

  const [cfg, { overrides }] = await Promise.all([
    getRuntimeConfig(),
    auth.comp.settingsRepo.getOverrides(),
  ]);

  return Response.json(
    buildEffective({
      cfg,
      overrides,
      lockedPaths: envLockedPaths(),
      embeddingModel: resolveEmbeddingModelId(),
    }),
  );
}
