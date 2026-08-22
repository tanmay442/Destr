import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { getComposition, assertSameOrigin, respondResult, respond } from '@/composition';
import { readBoundedText } from '@/lib/http';
import { ValidationError, CHAT_HISTORY_RATE_LIMIT, CHAT_MAX_BODY_BYTES } from '@app/domain';
import { V4_UUID_REGEX } from '@app/application/chat';

const RenameSchema = z.object({
  title: z.string().min(1).max(200),
});

type RouteContext = { params: Promise<{ id: string }> };

async function authorizeAndRateLimit(req: Request, options: { csrf: boolean }) {
  if (options.csrf) {
    const csrf = assertSameOrigin(req);
    if (csrf) return { error: csrf } as const;
  }

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
  const gate = await authorizeAndRateLimit(req, { csrf: false });
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const result = await gate.comp.getConversation({ userId: gate.userId, conversationId: id });
  return respondResult(result);
}

export async function PATCH(req: Request, context: RouteContext) {
  const gate = await authorizeAndRateLimit(req, { csrf: true });
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const bounded = await readBoundedText(req, CHAT_MAX_BODY_BYTES);
  if (!bounded.ok) {
    return bounded.reason === 'too-large'
      ? new Response('Payload too large', { status: 413 })
      : new Response('Bad Request', { status: 400 });
  }
  const contentType = req.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    return new Response('Content-Type must be application/json', { status: 415 });
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(bounded.text);
  } catch {
    raw = null;
  }
  const parsed = RenameSchema.safeParse(raw);
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
  const gate = await authorizeAndRateLimit(req, { csrf: true });
  if ('error' in gate) return gate.error;
  const { id } = await context.params;
  if (!V4_UUID_REGEX.test(id)) {
    return respond(new ValidationError('Invalid conversation id'));
  }
  const result = await gate.comp.deleteConversation({ userId: gate.userId, conversationId: id });
  return respondResult(result);
}
