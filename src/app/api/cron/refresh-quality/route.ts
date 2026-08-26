import { getComposition } from '@/composition';
import { logger } from '@app/domain';
import { hasValidCronSecret } from '@/lib/cron-auth';

export async function GET(req: Request) {
  if (!hasValidCronSecret(req, 'cron.refresh-quality')) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const comp = getComposition();
    await comp.chatEventBatcher.refreshDailyStats();
    const averages = await comp.chatEventBatcher.getJudgeAverages(7);
    logger.info('[refresh-quality] weekly quality snapshot', {
      event: 'cron.refresh_quality',
      avgFaithfulness: averages.avgFaithfulness,
      avgRetrievalRelevance: averages.avgRetrievalRelevance,
    });
    return Response.json({ ok: true, ...averages });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
