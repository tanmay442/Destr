import { z } from 'zod';
import { requireAdminRoute, respond } from '@/composition';
import { ValidationError } from '@app/domain';

const RoleSchema = z.object({
  role: z.enum(['admin', 'user']),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ clerkId: string }> },
) {
  const auth = await requireAdminRoute();
  if (!auth.ok) return auth.response;
  const { session, comp } = auth;
  const { clerkId } = await context.params;
  if (!clerkId || !/^[\w-]{1,255}$/.test(clerkId)) {
    return respond(new ValidationError('Invalid clerkId'));
  }
  const body = await req.json().catch(() => ({}));
  const parsed = RoleSchema.safeParse(body);
  if (!parsed.success) {
    return respond(new ValidationError('invalid_role', { issues: parsed.error.issues }));
  }
  const result = await comp.setUserRole({
    clerkUserId: clerkId,
    role: parsed.data.role as 'admin' | 'user',
    actorId: session.user.id,
  });
  if (!result.ok) return respond(result.error);
  return Response.json({ user: result.value });
}
