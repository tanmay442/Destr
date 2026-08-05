import { requireAdminGet, isTicketStatus, parseQueryPagination, respondResult } from '@/composition';

export async function GET(req: Request) {
  const auth = await requireAdminGet(req);
  if (!auth.ok) return auth.response;
  const { comp, url } = auth;
  const status = url.searchParams.get('status');
  const assigneeRaw = url.searchParams.get('assignee');
  const assignee = assigneeRaw === null ? undefined : assigneeRaw.slice(0, 255);
  const search = url.searchParams.get('search')?.slice(0, 200) ?? undefined;
  const { limit, offset } = parseQueryPagination(url);
  const result = await comp.listTickets({
    status: status && isTicketStatus(status) ? status : undefined,
    assignee: assignee === null ? undefined : assignee,
    search,
    limit,
    offset,
    actorId: auth.session.user.id,
  });
  return respondResult(result);
}
