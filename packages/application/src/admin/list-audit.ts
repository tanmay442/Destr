import { ok, ValidationError, type Result } from '@app/domain';
import type {
  AuditLog,
  AuditEventRecord,
  AuditKind,
  UserRepository,
  CursorPageInfo,
} from '@app/domain';
import { MAX_AUDIT_LIMIT } from '@app/domain';
import { requireAdminActor } from './authz';
import { decodeCursorAtBoundary, sanitizePagination, wrapServiceCall } from '../service-result';

export async function listAudit(
  input: {
    kind?: AuditKind | undefined;
    action?: string | undefined;
    actor?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    documentId?: number | undefined;
    ticketId?: string | undefined;
    limit?: number;
    offset?: number;
    cursor?: unknown;
    before?: unknown;
    actorId: string;
  },
  deps: { audit: AuditLog; users: UserRepository },
): Promise<Result<{ events: AuditEventRecord[]; total: number } & CursorPageInfo>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    const cursor = decodeCursorAtBoundary(input.cursor, 'audit');
    const before = decodeCursorAtBoundary(input.before, 'audit');
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_AUDIT_LIMIT, 50);
    const result = await deps.audit.list({
      kind: input.kind,
      action: input.action,
      actorId: input.actor,
      from: input.from,
      to: input.to,
      documentId: input.documentId,
      ticketId: input.ticketId,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
    });
    return ok({
      events: result.events,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      previousCursor: result.previousCursor ?? null,
    });
  }, 'Failed to list audit events');
}
