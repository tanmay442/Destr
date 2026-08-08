import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { AuditLog, AuditEventRecord, AuditKind, UserRepository } from '@app/domain';
import { MAX_AUDIT_LIMIT } from '@app/domain';
import { requireAdminActor } from './authz';
import { sanitizePagination } from '../service-result';

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
    actorId: string;
  },
  deps: { audit: AuditLog; users: UserRepository },
): Promise<Result<{ events: AuditEventRecord[]; total: number }>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_AUDIT_LIMIT, 50);
    const r = await deps.audit.list({
      kind: input.kind,
      action: input.action,
      actorId: input.actor,
      from: input.from,
      to: input.to,
      documentId: input.documentId,
      ticketId: input.ticketId,
      limit,
      offset,
    });
    return ok(r);
  } catch (e) {
    return err(new ExternalServiceError('Failed to list audit events', e));
  }
}
