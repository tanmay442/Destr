import { requireAdminRoute, respondResult } from '@/composition';

export async function GET() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;
  const result = await auth.comp.getAnalyticsSummary({ actorId: auth.session.user.id });
  return respondResult(result);
}
