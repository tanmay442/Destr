import { timingSafeEqual } from 'node:crypto';
import { getComposition, requireAdminRoute } from '@/composition';

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

function hasValidCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function GET(req: Request) {
  if (hasValidCronSecret(req)) return refresh();
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;
  return refresh();
}

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  return refresh();
}
