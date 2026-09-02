import { auth } from '@clerk/nextjs/server';
import { getComposition, respondResult } from '@/composition';
import { CHAT_HISTORY_RATE_LIMIT, MAX_LEGACY_LIST_OFFSET } from '@app/domain';

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const comp = getComposition();
  const limit = await comp.rateLimit(`chat_history:${userId}`, CHAT_HISTORY_RATE_LIMIT);
  if (!limit.ok) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: Number.isFinite(limit.retryAfterMs)
        ? { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) }
        : {},
    });
  }

  const url = new URL(req.url);
  function intParam(key: string, max?: number): number | undefined {
    const raw = url.searchParams.get(key);
    if (raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    return max === undefined ? value : Math.min(value, max);
  }
  const limitParam = intParam('limit', 100);
  const offsetParam = intParam('offset', MAX_LEGACY_LIST_OFFSET);
  const result = await comp.listConversations({
    userId,
    ...(limitParam !== undefined ? { limit: limitParam } : {}),
    ...(offsetParam !== undefined ? { offset: offsetParam } : {}),
  });
  return respondResult(result);
}
