import { timingSafeEqual } from 'node:crypto';
import { logger } from '@app/domain';

export function hasValidCronSecret(req: Request, warnLabel?: string): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (warnLabel !== undefined) {
      logger.warn(`[${warnLabel}] CRON_SECRET is not set — cron auth will fail until it is configured`);
    }
    return false;
  }
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
