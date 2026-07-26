import { requireAdminGet, respondResult } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const result = await auth.comp.getTicketIntelligence({ actorId: auth.session.user.id });
  return respondResult(result);
}
