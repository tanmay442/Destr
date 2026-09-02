import {
  DomainError,
  ExternalServiceError,
  ValidationError,
  type AdminListCursor,
  type AuditListCursor,
  type CursorContext,
  type CursorDecodeResult,
  type DocumentListCursor,
  type ListCursorKind,
  type ListCursorCodec,
  type Result,
  type TicketListCursor,
  type UserListCursor,
  err,
  ok,
  MAX_LEGACY_LIST_OFFSET,
} from '@app/domain';

export type { Result } from '@app/domain';

export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'documents', codec: ListCursorCodec, context: CursorContext): DocumentListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'tickets', codec: ListCursorCodec, context: CursorContext): TicketListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'users', codec: ListCursorCodec, context: CursorContext): UserListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: 'audit', codec: ListCursorCodec, context: CursorContext): AuditListCursor | undefined;
export function decodeCursorAtBoundary(raw: unknown, expectedKind: ListCursorKind, codec: ListCursorCodec, context: CursorContext): AdminListCursor | undefined;
export function decodeCursorAtBoundary(
  raw: unknown,
  expectedKind: ListCursorKind,
  codec: ListCursorCodec,
  context: CursorContext,
): AdminListCursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ValidationError(`Invalid ${expectedKind} pagination cursor`);
  }
  if (context.resource !== expectedKind) {
    throw new ValidationError(`Invalid ${expectedKind} pagination cursor`);
  }
  const decoded: CursorDecodeResult = codec.decode(raw, context);
  switch (decoded.kind) {
    case 'valid':
      return decoded.payload;
    case 'expired':
      throw new ValidationError(`Expired ${expectedKind} pagination cursor`);
    case 'invalid':
      throw new ValidationError(`Invalid ${expectedKind} pagination cursor`);
    default: {
      const exhaustive: never = decoded;
      return exhaustive;
    }
  }
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
    offset: Math.min(Math.max(Math.floor(offset), 0), MAX_LEGACY_LIST_OFFSET),
  };
}
