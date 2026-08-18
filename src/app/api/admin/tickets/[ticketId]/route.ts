import { z } from 'zod';
import { requireAdminRoute, TICKET_STATUSES, respond } from '@/composition';
import { ValidationError, MAX_TICKET_NOTES_LENGTH } from '@app/domain';
import { capCodePoints } from '@app/application';
import { sanitizeText } from '@/lib/sanitize';

const PatchSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  assignedTo: z.string().min(1).max(255).nullable().optional(),
  note: z.string().min(1).optional(),
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
  let note: string | undefined;
  if (parsed.data.note !== undefined) {
    note = capCodePoints(sanitizeText(parsed.data.note), MAX_TICKET_NOTES_LENGTH);
    if (!note) return respond(new ValidationError('Note must contain text'));
  }
  const result = await comp.updateTicket({
    ticketId,
    status: parsed.data.status,
    assignedTo: parsed.data.assignedTo,
    note,
    actorId: session.user.id,
  });
  if (!result.ok) return respond(result.error);
  return Response.json({ ticket: result.value });
}
