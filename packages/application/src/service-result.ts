import {
  decodeListCursor,
  DomainError,
  ExternalServiceError,
  ValidationError,
  type AdminListCursor,
  type AuditListCursor,
  type DocumentListCursor,
  type ListCursorKind,
  type Result,
  type TicketListCursor,
  type UserListCursor,
  err,
  ok,
} from '@app/domain';

export type { Result } from '@app/domain';

export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'documents'): DocumentListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'tickets'): TicketListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'users'): UserListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'audit'): AuditListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: ListCursorKind): AdminListCursor | undefined;
export function decodeCursorAtBoundary(
  raw: unknown,
  expectedKind: ListCursorKind,
): AdminListCursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeListCursor(raw, expectedKind);
  if (cursor === null) {
    throw new ValidationError(`Invalid ${expectedKind} pagination cursor`);
  }
  return cursor;
}

/** DomainErrors pass through unwrapped; unknown throws become ExternalServiceError. */
export async function wrapServiceCall<T>(
  op: () => Promise<Result<T>>,
  message: string,
): Promise<Result<T>> {
  try {
    return await op();
  } catch (e) {
    if (e instanceof DomainError) {
      return err(e);
    }
    return err(new ExternalServiceError(message, e));
  }
}

export async function serviceResult<T>(
  op: () => Promise<T>,
  message: string,
): Promise<Result<T>> {
  return wrapServiceCall(async () => ok(await op()), message);
}

export function sanitizePagination(
  rawLimit: number | undefined | null,
  rawOffset: number | undefined | null,
  maxLimit: number,
  defaultLimit = 25,
): { limit: number; offset: number } {
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : defaultLimit;
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : 0;
  return {
    limit: Math.min(Math.max(Math.floor(limit), 1), maxLimit),
    offset: Math.max(Math.floor(offset), 0),
  };
}
