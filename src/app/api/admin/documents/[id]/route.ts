import { requireAdminRoute, respond } from '@/composition';
import { ValidationError } from '@app/domain';

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;
  const { id } = await context.params;
  const docId = Number(id);
  if (!Number.isInteger(docId)) {
    return respond(new ValidationError('Invalid id'));
  }
  const result = await comp.hardDeleteDocument({ documentId: docId, actorId: session.user.id });
  if (!result.ok) return respond(result.error);
  return Response.json({ ok: true });
}
