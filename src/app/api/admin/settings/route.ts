import { requireAdminRoute } from '@/composition';
import { getRuntimeConfig, invalidateRuntimeConfig, envLockedPaths } from '@/lib/config/runtime';
import { partialAppConfigSchema, type AppConfig } from '@app/domain/app-config';
import {
  buildEffective,
  deepGet,
  flattenSchema,
  lockedPathsInPatch,
  mergePatch,
  resolveEmbeddingModelId,
} from './descriptor';

const WRITE_WINDOW_MS = 5_000;

function settingsDiff(before: AppConfig, after: AppConfig) {
  return [...flattenSchema().keys()]
    .map((key) => ({ key, old: deepGet(before, key), new: deepGet(after, key) }))
    .filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.new));
}

export async function GET() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;

  const [cfg, { overrides, version }] = await Promise.all([
    getRuntimeConfig(),
    auth.comp.settingsRepo.getOverrides(),
  ]);

  const effective = buildEffective({
    cfg,
    overrides,
    lockedPaths: envLockedPaths(),
    embeddingModel: resolveEmbeddingModelId(),
  });

  const values: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  for (const [key, { value, source }] of Object.entries(effective)) {
    values[key] = value;
    sources[key] = source;
  }

  return Response.json({ version, values, sources });
}

export async function PUT(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;

  const actorId = auth.session.user.id;
  const limit = await auth.comp.rateLimit(`settings:${actorId}`, { limit: 1, windowMs: WRITE_WINDOW_MS });
  if (!limit.ok) {
    const retryAfter = Number.isFinite(limit.retryAfterMs) ? String(Math.ceil(limit.retryAfterMs / 1000)) : '5';
    return Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': retryAfter } });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { patch: rawPatch, expectedVersion } = (body ?? {}) as {
    patch?: unknown;
    expectedVersion?: unknown;
  };
  if (typeof expectedVersion !== 'number') {
    return Response.json({ error: 'expectedVersion (number) is required' }, { status: 400 });
  }

  const parsed = partialAppConfigSchema.safeParse(rawPatch);
  if (!parsed.success) {
    return Response.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  }
  const patch = parsed.data as Partial<AppConfig>;

  const locked = lockedPathsInPatch(patch, envLockedPaths());
  if (locked.length > 0) {
    return Response.json({ error: 'Env-locked fields cannot be modified', locked }, { status: 422 });
  }

  if (patch.rerankerProvider) {
    const status = auth.comp.availableRerankers().get(patch.rerankerProvider);
    if (status && !status.ok) {
      return Response.json(
        { error: 'Reranker provider unavailable', provider: patch.rerankerProvider, reason: status.reason },
        { status: 422 },
      );
    }
  }

  const { overrides } = await auth.comp.settingsRepo.getOverrides();
  const merged = mergePatch(overrides, patch);

  const before = await getRuntimeConfig();
  const result = await auth.comp.settingsRepo.saveOverrides({ patch: merged, actorId, expectedVersion });
  if ('conflict' in result) {
    const { version } = await auth.comp.settingsRepo.getOverrides();
    return Response.json({ error: 'Version conflict', version }, { status: 409 });
  }

  invalidateRuntimeConfig();
  const after = await getRuntimeConfig();
  await auth.comp.logSettingsChange({ actorId, changes: settingsDiff(before, after) });

  return Response.json({ version: result.version });
}
