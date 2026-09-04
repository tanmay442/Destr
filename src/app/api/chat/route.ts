import { assertSameOrigin } from '@/composition';
import { isRequestCancellationError } from '@app/domain';
import { logger } from '@/lib/logger';
import { respond } from '@/lib/http';
import { chatSlotOwners, releaseOwnedChatSlot } from './slots';
import { streamChatResponseUseCase } from './handler';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const csrf = assertSameOrigin(req);
    if (csrf) return csrf;
    return streamChatResponseUseCase(req);
  } catch (error) {
    const userId = chatSlotOwners.get(req);
    if (userId) releaseOwnedChatSlot(req, userId);
    if (req.signal.aborted && isRequestCancellationError(error)) return new Response(null, { status: 499 });
    logger.error('Chat request failed', { error: String(error) });
    return respond(error);
  }
}
