import { getComposition, requireAdminRoute } from '@/composition';
import { hasValidCronSecret } from '@/lib/cron-auth';
import { logger } from '@app/domain';

async function refresh() {
  try {
    await getComposition().chatEventBatcher.refreshDailyStats();
    return Response.json({ ok: true });
  } catch (e) {
    logger.error('[rollup] refresh failed', { error: e });
    return Response.json(
      { ok: false, error: 'Internal error', code: 'internal_error' },
      { status: 503 },
    );
  }
}

export async function GET(req: Request) {
  if (!hasValidCronSecret(req, 'cron.rollup')) {
    return new Response('Unauthorized', { status: 401 });
  }
  return refresh();
}

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  return refresh();
}
