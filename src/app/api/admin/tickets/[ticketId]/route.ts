import { z } from 'zod';
import { requireAdminRoute, TICKET_STATUSES, respond } from '@/composition';
import { ValidationError } from '@app/domain';

const PatchSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  assignedTo: z.string().min(1).max(255).nullable().optional(),
  note: z.string().min(1).max(10_000).optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ ticketId: string }> },
) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;
  const { ticketId } = await context.params;
  if (!ticketId || !/^[\w-]{1,255}$/.test(ticketId)) {
    return respond(new ValidationError('Invalid ticketId'));
  }
  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return respond(new ValidationError('Invalid payload', { issues: parsed.error.issues }));
  }
  if (typeof parsed.data.assignedTo === 'string') {
    const assignee = await comp.getUserByClerkId(parsed.data.assignedTo);
    if (!assignee.ok) return respond(assignee.error);
    if (!assignee.value.user) {
      return respond(new ValidationError('Unknown assignee'));
    }
  }
  const result = await comp.updateTicket({
    ticketId,
    status: parsed.data.status,
    assignedTo: parsed.data.assignedTo,
    note: parsed.data.note,
    actorId: session.user.id,
  });
  if (!result.ok) return respond(result.error);
  return Response.json({ ticket: result.value });
}
