import { and, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import type { AdminListCursor, CursorContext, ListCursorCodec, ListCursorPayload } from '@app/domain';
import { ValidationError } from '@app/domain';

export type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function whereAnd(parts: SQL[]) {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

export function requiredOr(...parts: SQL[]): SQL {
  const condition = or(...parts);
  if (condition === undefined) throw new Error('Expected at least one SQL condition');
  return condition;
}

export function requiredAnd(...parts: SQL[]): SQL {
  const condition = and(...parts);
  if (condition === undefined) throw new Error('Expected at least one SQL condition');
  return condition;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function encodeRepositoryCursor(
  cursor: AdminListCursor,
  codec: ListCursorCodec | undefined,
  context: CursorContext | undefined,
): string {
  if (codec === undefined || context === undefined) {
    throw new ValidationError('Signed cursor codec and context are required');
  }
  if (context.resource !== cursor.kind) {
    throw new ValidationError('Signed cursor context does not match the resource');
  }
  const payload: ListCursorPayload = {
    ...cursor,
    filterFingerprint: context.filterFingerprint,
    sort: context.sort,
  };
  return codec.encode(payload);
}
