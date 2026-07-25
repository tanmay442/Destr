import { z } from 'zod';
import { requireAdminRoute, respond } from '@/composition';
import { ValidationError } from '@app/domain';

const GdprSchema = z.object({
  action: z.enum(['purge', 'anonymize']),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ clerkId: string }> },
) {
  const auth = await requireAdminRoute(req);
  if (!auth.ok) return auth.response;
  const { comp } = auth;
  const { clerkId } = await context.params;
  if (!clerkId || !/^[\w-]{1,255}$/.test(clerkId)) {
    return respond(new ValidationError('Invalid clerkId'));
  }
  const body = await req.json().catch(() => ({}));
  const parsed = GdprSchema.safeParse(body);
  if (!parsed.success) {
    return respond(new ValidationError('invalid_action', { issues: parsed.error.issues }));
  }
  const result =
    parsed.data.action === 'purge'
      ? await comp.chatEventBatcher.purgeUserData(clerkId)
      : await comp.chatEventBatcher.anonymizeUserData(clerkId);
  return Response.json(result);
}
