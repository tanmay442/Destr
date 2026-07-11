import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ConflictError } from '@app/domain';
import type { TicketRepository, AuditLog } from '@app/domain';
import { updateTicket, createTicket, VALID_TRANSITIONS, isTicketStatus } from '../tickets';

function makeMockRepos(overrides: { tickets?: Partial<TicketRepository>; audit?: Partial<AuditLog> } = {}) {
  const tickets = {
    findByTicketId: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue({ ticketId: 'TKT-12345678', status: 'created' }),
    update: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    latest: vi.fn().mockResolvedValue(null),
    countAll: vi.fn().mockResolvedValue(0),
    countOpen: vi.fn().mockResolvedValue(0),
    ...overrides.tickets,
  } as TicketRepository;
  const audit = {
    logTicketEvent: vi.fn().mockResolvedValue(undefined),
    logDocumentEvent: vi.fn().mockResolvedValue(undefined),
    logUserEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides.audit,
  } as AuditLog;
  return { tickets, audit };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('updateTicket', () => {
  it('returns NotFoundError for missing ticket', async () => {
    const deps = makeMockRepos();
    const result = await updateTicket(
      { ticketId: 'TKT-MISSING', status: 'closed', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('returns ConflictError for invalid status transition', async () => {
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue({
          ticketId: 'TKT-1001',
          status: 'closed',
          notes: null,
        }),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'created', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ConflictError);
    }
  });

  it('returns NotFoundError when update returns null (race condition)', async () => {
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue({
          ticketId: 'TKT-1001',
          status: 'created',
          notes: null,
        }),
        update: vi.fn().mockResolvedValue(null),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'in_progress', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
  });

  it('updates notes without status change', async () => {
    const existing = {
      ticketId: 'TKT-1001',
      status: 'created' as const,
      notes: 'old note',
    };
    const updated = { ...existing, notes: 'new note' };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', note: 'new note', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(updated);
    }
  });

  it('allows valid transition: created → in_progress', async () => {
    const existing = {
      ticketId: 'TKT-1001',
      status: 'created' as const,
      notes: null,
    };
    const updated = { ...existing, status: 'in_progress' as const };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'in_progress', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it('allows valid transition: created → closed', async () => {
    const existing = {
      ticketId: 'TKT-1001',
      status: 'created' as const,
      notes: null,
    };
    const updated = { ...existing, status: 'closed' as const };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'closed', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it('allows a no-op update to the current status', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(existing),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'created', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it('sanitizes the note in the shared use-case', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, notes: 'clean' }),
      },
    });
    await updateTicket(
      { ticketId: 'TKT-1001', note: '  dirty\r\n note\x00', actorId: 'user_1' },
      deps,
    );
    expect(deps.tickets.update).toHaveBeenCalledWith(
      'TKT-1001',
      expect.objectContaining({ notes: 'dirty\n note' }),
    );
  });

  it('truncates a long first note to MAX_TICKET_NOTES_LENGTH', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const longNote = 'x'.repeat(20_000);
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, notes: 'x'.repeat(10_000) }),
      },
    });
    await updateTicket(
      { ticketId: 'TKT-1001', note: longNote, actorId: 'user_1' },
      deps,
    );
    const call = vi.mocked(deps.tickets.update).mock.calls[0][1] as { notes: string };
    expect(call.notes.length).toBe(10_000);
  });

  it('logs both status_change and assign when both are set', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, status: 'in_progress', assignedTo: 'u2' }),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', status: 'in_progress', assignedTo: 'u2', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.audit.logTicketEvent).toHaveBeenCalledWith(
      { action: 'status_change', ticketId: 'TKT-1001', actorId: 'user_1' },
    );
    expect(deps.audit.logTicketEvent).toHaveBeenCalledWith(
      { action: 'assign', ticketId: 'TKT-1001', actorId: 'user_1' },
    );
  });
});

describe('createTicket', () => {
  it('creates a ticket with generated ID', async () => {
    const deps = makeMockRepos();
    const result = await createTicket(
      { userId: 'user_1', name: 'Test', email: 't@x.com', issue: 'help' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ticketId).toMatch(/^TKT-[a-f0-9]{8}$/);
      expect(result.value.status).toBe('created');
    }
    expect(deps.tickets.insert).toHaveBeenCalledOnce();
    expect(deps.audit.logTicketEvent).toHaveBeenCalledOnce();
  });

  it('logs audit with create action', async () => {
    const deps = makeMockRepos();
    await createTicket(
      { userId: 'user_1', name: 'Test', email: 't@x.com', issue: 'help' },
      deps,
    );
    expect(deps.audit.logTicketEvent).toHaveBeenCalledWith({
      action: 'create',
      ticketId: 'TKT-12345678',
      actorId: 'user_1',
    });
  });

  it('returns ExternalServiceError when insert fails', async () => {
    const deps = makeMockRepos({
      tickets: {
        insert: vi.fn().mockRejectedValue(new Error('DB down')),
      },
    });
    const result = await createTicket(
      { userId: 'user_1', name: 'Test', email: 't@x.com', issue: 'help' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('external_service');
    }
  });
});

describe('isTicketStatus', () => {
  it('returns true for valid statuses', () => {
    expect(isTicketStatus('created')).toBe(true);
    expect(isTicketStatus('in_progress')).toBe(true);
    expect(isTicketStatus('closed')).toBe(true);
  });

  it('returns false for invalid statuses', () => {
    expect(isTicketStatus('bogus')).toBe(false);
    expect(isTicketStatus('open')).toBe(false);
    expect(isTicketStatus('')).toBe(false);
  });
});

describe('VALID_TRANSITIONS', () => {
  it('created can go to in_progress and closed', () => {
    expect(VALID_TRANSITIONS.created).toContain('in_progress');
    expect(VALID_TRANSITIONS.created).toContain('closed');
  });

  it('closed has no valid transitions', () => {
    expect(VALID_TRANSITIONS.closed).toHaveLength(0);
  });
});
