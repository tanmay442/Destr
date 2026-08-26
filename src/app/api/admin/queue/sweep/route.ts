import { getComposition, requireAdminRoute } from '@/composition';
import { hasValidCronSecret } from '@/lib/cron-auth';

async function sweep() {
  try {
    const result = await getComposition().sweepStaleQueued();
    return Response.json({ ok: true, failed: result.failed });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
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
