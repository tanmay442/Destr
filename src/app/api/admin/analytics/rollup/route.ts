import { requireAdminRoute } from '@/composition';

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  try {
    await auth.comp.chatEventBatcher.refreshDailyStats();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
