import { z } from 'zod';
import { requireAdminRoute, respond } from '@/composition';
import { ValidationError, ForbiddenError, NotFoundError, ExternalServiceError } from '@app/domain';

const GdprSchema = z.object({
  action: z.enum(['purge', 'anonymize']),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ clerkId: string }> },
) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;
  const { clerkId } = await context.params;
  if (!clerkId || !/^[\w-]{1,255}$/.test(clerkId)) {
    return respond(new ValidationError('Invalid clerkId'));
  }
  if (session.user.id === clerkId) {
    return respond(new ForbiddenError('Cannot purge your own data'));
  }
  const existing = await comp.getUserByClerkId(clerkId);
  if (!existing.ok) return respond(existing.error);
  if (!existing.value.user) {
    return respond(new NotFoundError('User not found'));
  }
  const body = await req.json().catch(() => ({}));
  const parsed = GdprSchema.safeParse(body);
  if (!parsed.success) {
    return respond(new ValidationError('invalid_action', { issues: parsed.error.issues }));
  }
  const action = parsed.data.action;
  const auditAction = action === 'purge' ? 'gdpr_purge' : 'gdpr_anonymize';
  let eventsResult: { deletedCount: number } | { updatedCount: number };
  try {
    eventsResult =
      action === 'purge'
        ? await comp.chatEventBatcher.purgeUserData(clerkId)
        : await comp.chatEventBatcher.anonymizeUserData(clerkId);
  } catch (e) {
    return respond(new ExternalServiceError('GDPR action failed', e));
  }
  let chatPurged: { deletedConversations: number; deletedMessages: number };
  try {
    chatPurged = await comp.chatHistoryRepo.purgeUserData(clerkId);
  } catch (e) {
    await comp.logUserAudit({
      action: auditAction,
      actorId: session.user.id,
      targetId: clerkId,
      details: { partial: true, chatEvents: eventsResult, chatHistory: 'failed' },
    });
    return respond(new ExternalServiceError('GDPR action failed', e));
  }
  await comp.logUserAudit({
    action: auditAction,
    actorId: session.user.id,
    targetId: clerkId,
  });
  if (action === 'purge') {
    (eventsResult as { deletedChatConversations?: number }).deletedChatConversations =
      chatPurged.deletedConversations;
  }
  return Response.json(eventsResult);
}