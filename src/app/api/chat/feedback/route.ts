import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { getComposition, assertSameOrigin, respondResult, respond } from '@/composition';
import { ValidationError } from '@app/domain';
import { logger } from '@/lib/logger';
import { CHAT_RATE_LIMIT } from '../../../../../config/constants';

const FeedbackRequestSchema = z.object({
  turnId: z.string().uuid(),
  feedback: z.union([z.literal(1), z.literal(-1)]),
  documentIds: z.array(z.number().int().nonnegative()).max(50).optional(),
  chunkIds: z.array(z.number().int().nonnegative()).max(50).optional(),
});

export async function POST(req: Request) {
  try {
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;

    const { userId } = await auth();
    if (!userId) return new Response('Unauthorized', { status: 401 });

    const comp = getComposition();
    const limit = await comp.enforceRateLimit({ key: `feedback:${userId}`, ...CHAT_RATE_LIMIT });
    if (!limit.ok) return respond(limit.error);

    const contentType = req.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      return new Response('Content-Type must be application/json', { status: 415 });
    }

    const raw = await req.json().catch(() => null);
    const parsed = FeedbackRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return respond(new ValidationError('Invalid feedback request', { issues: parsed.error.issues }));
    }

    const result = await comp.submitChatFeedback({
      userId,
      turnId: parsed.data.turnId,
      feedback: parsed.data.feedback,
      documentIds: parsed.data.documentIds ?? [],
      chunkIds: parsed.data.chunkIds ?? [],
    });
    return respondResult(result);
  } catch (error) {
    logger.error('POST /api/chat/feedback unhandled error', { error });
    return respond(error);
  }
}

