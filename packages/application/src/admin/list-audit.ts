import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { AuditLog, AuditEventRecord, AuditKind, UserRepository } from '@app/domain';
import { MAX_AUDIT_LIMIT } from '../../../../config/constants';
import { requireAdminActor } from './authz';

export async function listAudit(
  input: {
    kind?: AuditKind;
    action?: string;
    actor?: string;
    from?: Date;
    to?: Date;
    documentId?: number;
    ticketId?: string;
    limit?: number;
    offset?: number;
    actorId: string;
  },
  deps: { audit: AuditLog; users: UserRepository },
): Promise<Result<{ events: AuditEventRecord[]; total: number }>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), MAX_AUDIT_LIMIT);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);
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
