import { requireAdminRoute } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;

  const pending = await auth.comp.countPendingIngest();
  return Response.json({ pending });
}
