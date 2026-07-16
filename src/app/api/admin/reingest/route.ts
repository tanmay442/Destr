import { requireAdminRoute, respondResult } from '@/composition';

export async function POST() {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;
  const result = await auth.comp.reingestAll();
  return respondResult(result);
}
