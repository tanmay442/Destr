import { requireAdminGet, respondResult } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const rawDays = Number(auth.url.searchParams.get('days'));
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : undefined;
  const result = await auth.comp.getAnalyticsTrends({ actorId: auth.session.user.id, days });
  return respondResult(result);
}
