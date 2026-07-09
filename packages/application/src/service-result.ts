import { err, ok, type Result } from '@app/domain';
import { ExternalServiceError } from '@app/domain';

/** Wrap an async Result-returning op; unhandled throws become
 *  ExternalServiceError, but `err(...)` results pass through. */
export async function wrapServiceCall<T>(
  op: () => Promise<Result<T>>,
  message: string,
): Promise<Result<T>> {
  try {
    return await op();
  } catch (e) {
    return err(new ExternalServiceError(message, e));
  }
}

/** Wrap an async raw-value op into Result; throws become ExternalServiceError. */
export async function serviceResult<T>(
  op: () => Promise<T>,
  message: string,
): Promise<Result<T>> {
  try {
    return ok(await op());
  } catch (e) {
    return err(new ExternalServiceError(message, e));
  }
}

/** Clamp and sanitise pagination parameters (used by all admin list handlers). */
export function sanitizePagination(
  rawLimit: number | undefined | null,
  rawOffset: number | undefined | null,
  maxLimit: number,
  defaultLimit = 25,
): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(Math.floor(rawLimit ?? defaultLimit), 1), maxLimit),
    offset: Math.max(Math.floor(rawOffset ?? 0), 0),
  };
}
