// Use-case: log document and ticket audit events.
import { ok, type Result } from '@app/domain';
import type { AuditLog } from '@app/domain';

export async function logDocumentEvent(
  input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
  deps: { audit: AuditLog },
): Promise<Result<void>> {
  await deps.audit.logDocumentEvent(input);
  return ok(undefined);
}

export async function logTicketEvent(
  input: {
    action: 'create' | 'assign' | 'status_change' | 'note' | 'role_change';
    ticketId: string;
    actorId: string;
  },
  deps: { audit: AuditLog },
): Promise<Result<void>> {
  await deps.audit.logTicketEvent(input);
  return ok(undefined);
}
