import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { getComposition, assertSameOrigin, respondResult, respond } from '@/composition';
import { ValidationError, CHAT_HISTORY_RATE_LIMIT } from '@app/domain';
import { V4_UUID_REGEX } from '@app/application/chat';

const RenameSchema = z.object({
  title: z.string().min(1).max(200),
});

type RouteContext = { params: Promise<{ id: string }> };

async function authorizeAndRateLimit(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return { error: csrf } as const;

  const { userId } = await auth();
  if (!userId) return { error: new Response('Unauthorized', { status: 401 }) } as const;

  const comp = getComposition();
  const limit = await comp.rateLimit(`chat_history:${userId}`, CHAT_HISTORY_RATE_LIMIT);
  if (!limit.ok) {
    return {
      error: new Response('Too Many Requests', {
        status: 429,
        headers: Number.isFinite(limit.retryAfterMs)
          ? { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) }
          : {},
      }),
    } as const;
  }
  return { comp, userId } as const;
}

export async function GET(req: Request, context: RouteContext) {
  const gate = await authorizeAndRateLimit(req);
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const result = await gate.comp.getConversation({ userId: gate.userId, conversationId: id });
  return respondResult(result);
}

export async function PATCH(req: Request, context: RouteContext) {
  const gate = await authorizeAndRateLimit(req);
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const body = await req.json().catch(() => null);
  const parsed = RenameSchema.safeParse(body);
  if (!parsed.success) {
    return respond(new ValidationError('Invalid rename request', { issues: parsed.error.issues }));
  }
  const result = await gate.comp.renameConversation({
    userId: gate.userId,
    conversationId: id,
    title: parsed.data.title,
  });
  return respondResult(result);
}

export async function DELETE(req: Request, context: RouteContext) {
  const gate = await authorizeAndRateLimit(req);
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const result = await gate.comp.deleteConversation({ userId: gate.userId, conversationId: id });
  return respondResult(result);
}
