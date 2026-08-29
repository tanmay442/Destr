import { getComposition, requireAdminRoute } from '@/composition';
import { hasValidCronSecret } from '@/lib/cron-auth';
import { logger } from '@app/domain';

async function sweep() {
  try {
    const result = await getComposition().sweepStaleQueued();
    return Response.json({ ok: true, failed: result.failed });
  } catch (e) {
    logger.error('[sweep] sweep failed', { error: e });
    return Response.json(
      { ok: false, error: 'Internal error', code: 'internal_error' },
      { status: 503 },
    );
  }
}

export async function GET(req: Request) {
  if (!hasValidCronSecret(req)) {
    return new Response('Method Not Allowed', { status: 405 });
  }
  return sweep();
}

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  return sweep();
}
