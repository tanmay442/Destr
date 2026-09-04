import {
  listUsers, setUserRole, touchLastSeen,
  getUserByClerkId, logDocumentEvent, logTicketEvent,
  enforceRateLimit,
  listTickets, updateTicket,
  createTicket,
  listAudit, logSettingsChange,
} from '@app/application';
import { Auth } from '@app/infrastructure';
import {
  core,
  bind, cursorCodec, runner, rateLimitDeps,
} from './infra';

export function buildAdminOps() {
  const auditDeps = { audit: core.auditRepo };
  const userDeps = { users: core.userRepo };
  const txRunner = runner;

  return {
    listUsers: (input: Parameters<typeof listUsers>[0]) => bind(listUsers, input, { ...userDeps, cursorCodec }),
    setUserRole: (input: Parameters<typeof setUserRole>[0]) =>
      bind(setUserRole, input, { ...userDeps, ...auditDeps, runner: txRunner, syncClerkRole: Auth.syncClerkUserRole }),
    touchLastSeen: (id: string) => bind(touchLastSeen, id, userDeps),
    getUserByClerkId: (id: string) => bind(getUserByClerkId, id, userDeps),
    logDocumentEvent: (input: Parameters<typeof logDocumentEvent>[0]) => bind(logDocumentEvent, input, auditDeps),
    logSettingsChange: (input: Parameters<typeof logSettingsChange>[0]) => logSettingsChange(input, auditDeps),
    logTicketEvent: (input: Parameters<typeof logTicketEvent>[0]) => bind(logTicketEvent, input, auditDeps),
    logUserAudit: (input: { action: string; actorId: string; targetId: string; details?: Record<string, unknown> }) =>
      auditDeps.audit.logEvent({
        kind: 'user',
        action: input.action,
        actorId: input.actorId,
        targetType: 'user',
        targetId: input.targetId,
        ...(input.details !== undefined ? { details: input.details } : {}),
      }),
    enforceRateLimit: (input: Parameters<typeof enforceRateLimit>[0]) => bind(enforceRateLimit, input, rateLimitDeps),
    listTickets: (input: Parameters<typeof listTickets>[0]) => bind(listTickets, input, { tickets: core.ticketRepo, ...userDeps, cursorCodec }),
    updateTicket: (input: Parameters<typeof updateTicket>[0]) =>
      bind(updateTicket, input, { tickets: core.ticketRepo, ...auditDeps, ...userDeps, runner: txRunner }),
    createTicket: (input: Parameters<typeof createTicket>[0]) =>
      bind(createTicket, input, { tickets: core.ticketRepo, ...auditDeps }),
    listAudit: (input: Parameters<typeof listAudit>[0]) => bind(listAudit, input, { ...auditDeps, ...userDeps, cursorCodec }),
  };
}
