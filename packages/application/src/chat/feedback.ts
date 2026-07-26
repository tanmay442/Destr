import { err, ok, type Result, NotFoundError, ForbiddenError, ExternalServiceError } from '@app/domain';
import type { ChatFeedbackRepo } from '@app/domain';

export interface SubmitChatFeedbackInput {
  userId: string;
  turnId: string;
  feedback: 1 | -1;
  documentIds: number[];
  chunkIds: number[];
}

export async function submitChatFeedback(
  input: SubmitChatFeedbackInput,
  deps: { feedback: ChatFeedbackRepo },
): Promise<Result<{ ok: true }>> {
  try {
    const outcome = await deps.feedback.upsertFeedback(input);
    if (outcome === 'not_found') {
      return err(new NotFoundError('Chat turn not found'));
    }
    if (outcome === 'forbidden') {
      return err(new ForbiddenError('Cannot submit feedback for another user\'s turn'));
    }
    return ok({ ok: true });
  } catch (e) {
    return err(new ExternalServiceError('Failed to submit feedback', e));
  }
}
