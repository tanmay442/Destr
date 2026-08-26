import { getComposition, requireAdminRoute } from '@/composition';
import { hasValidCronSecret } from '@/lib/cron-auth';

async function refresh() {
  try {
    await getComposition().chatEventBatcher.refreshDailyStats();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
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
