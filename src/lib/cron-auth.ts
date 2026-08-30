import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { logger } from '@app/domain';

export function hasValidCronSecret(req: Request, warnLabel?: string): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get('authorization');
  const providedRaw = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!secret) {
    const dummy = randomBytes(32);
    const fakeProvided = providedRaw !== null
      ? createHash('sha256').update(Buffer.from(providedRaw, 'utf-8')).digest()
      : randomBytes(32);
    try {
      timingSafeEqual(fakeProvided, dummy);
    } catch {}
    if (warnLabel !== undefined) {
      logger.warn(`[${warnLabel}] CRON_SECRET is not set — cron auth will fail until it is configured`);
    }
    return false;
  }
  if (providedRaw === null) return false;
  const providedDigest = createHash('sha256').update(Buffer.from(providedRaw, 'utf-8')).digest();
  const expectedDigest = createHash('sha256').update(Buffer.from(secret, 'utf-8')).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
