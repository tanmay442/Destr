import { timingSafeEqual } from 'node:crypto';
import { getComposition } from '@/composition';
import { logger } from '@app/domain';

// §C7 nightly quality rollup: runs after the 02:00 stats cron so the judge
// averages reflect the refreshed daily view.
function hasValidCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function GET(req: Request) {
  if (!hasValidCronSecret(req)) {
    return new Response('Method Not Allowed', { status: 405 });
  }
  try {
    const comp = getComposition();
    await comp.chatEventBatcher.refreshDailyStats();
    const averages = await comp.chatEventBatcher.getJudgeAverages(7);
    logger.info('[refresh-quality] weekly quality snapshot', {
      event: 'cron.refresh_quality',
      avgFaithfulness: averages.avgFaithfulness,
      avgRetrievalRelevance: averages.avgRetrievalRelevance,
      degradedRate: averages.degradedRate,
    });
    return Response.json({ ok: true, ...averages });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
