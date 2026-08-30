import { getComposition } from '@/composition';
import { getRuntimeConfig } from '@/lib/config/runtime';
import { hasValidCronSecret } from '@/lib/cron-auth';
import { logger } from '@app/domain';

export const maxDuration = 60;

const DAY_MS = 86_400_000;
const DEFAULT_CHAT_EVENT_RETENTION_DAYS = 90;

type PurgeCounts = {
  deletedConversations: number;
  deletedMessages: number;
};

function resolveChatEventRetentionDays(): number {
  const raw = process.env.CHAT_EVENT_RETENTION_DAYS ?? process.env.CHAT_EVENTS_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CHAT_EVENT_RETENTION_DAYS;

  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    logger.warn('[purge] invalid chat event retention; using default', {
      raw,
      defaultDays: DEFAULT_CHAT_EVENT_RETENTION_DAYS,
    });
    return DEFAULT_CHAT_EVENT_RETENTION_DAYS;
  }
  return days;
}

export async function GET(req: Request): Promise<Response> {
  if (!hasValidCronSecret(req, 'cron.purge')) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const composition = getComposition();
    const config = await getRuntimeConfig();
    const now = Date.now();
    const eventRetentionDays = resolveChatEventRetentionDays();
    const eventResult = await composition.chatEventBatcher.purgeOlderThan(
      new Date(now - eventRetentionDays * DAY_MS),
    );

    const historyResult: PurgeCounts = config.chatHistoryRetentionDays === 0
      ? { deletedConversations: 0, deletedMessages: 0 }
      : await composition.chatHistoryRepo.purgeOlderThan(
          new Date(now - config.chatHistoryRetentionDays * DAY_MS),
        );

    return Response.json({
      ok: true,
      chatHistory: {
        retentionDays: config.chatHistoryRetentionDays,
        ...historyResult,
      },
      chatEvents: {
        retentionDays: eventRetentionDays,
        deletedCount: eventResult.deletedCount,
      },
    });
  } catch (error) {
    logger.error('[purge] failed', { error });
    return Response.json(
      { ok: false, error: 'Internal error', code: 'internal_error' },
      { status: 503 },
    );
  }
}
