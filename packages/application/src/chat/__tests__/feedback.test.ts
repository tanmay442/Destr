import { describe, it, expect } from 'vitest';
import { submitChatFeedback } from '../feedback';
import { unwrap, NotFoundError, ForbiddenError } from '@app/domain';
import type { ChatFeedbackRepo, FeedbackUpsertResult } from '@app/domain';

function repoReturning(outcome: FeedbackUpsertResult, calls: unknown[] = []): ChatFeedbackRepo {
  return {
    upsertFeedback: async (input: unknown) => {
      calls.push(input);
      return outcome;
    },
  } as unknown as ChatFeedbackRepo;
}

const input = { userId: 'u1', turnId: 't1', feedback: 1 as const, documentIds: [1], chunkIds: [2] };

describe('submitChatFeedback', () => {
  it('returns ok when the upsert succeeds', async () => {
    const calls: unknown[] = [];
    const res = await submitChatFeedback(input, { feedback: repoReturning('ok', calls) });
    expect(unwrap(res)).toEqual({ ok: true });
    expect(calls[0]).toEqual(input);
  });

  it('maps not_found to a NotFoundError', async () => {
    const res = await submitChatFeedback(input, { feedback: repoReturning('not_found') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(NotFoundError);
  });

  it('maps forbidden to a ForbiddenError', async () => {
    const res = await submitChatFeedback(input, { feedback: repoReturning('forbidden') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(ForbiddenError);
  });

  it('allows changing the vote (down after up)', async () => {
    const calls: unknown[] = [];
    const repo = repoReturning('ok', calls);
    await submitChatFeedback({ ...input, feedback: 1 }, { feedback: repo });
    await submitChatFeedback({ ...input, feedback: -1 }, { feedback: repo });
    expect((calls[0] as { feedback: number }).feedback).toBe(1);
    expect((calls[1] as { feedback: number }).feedback).toBe(-1);
  });
});
