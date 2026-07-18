import { requireAdminRoute, respondResult } from '@/composition';

export async function POST(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const result = await auth.comp.reingestAll();
  return respondResult(result);
}
