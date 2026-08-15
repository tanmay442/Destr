import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ConflictError, ForbiddenError } from '@app/domain';
import type { TicketRepository, AuditLog, UserRepository } from '@app/domain';
import { updateTicket, createTicket, VALID_TRANSITIONS, isTicketStatus } from '../tickets';

function makeMockRepos(overrides: { tickets?: Partial<TicketRepository>; audit?: Partial<AuditLog>; users?: Partial<UserRepository> } = {}) {
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
    recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    ...overrides.audit,
  } as AuditLog;
  const users = {
    findByClerkId: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({ clerkUserId: id, email: `${id}@x.com`, name: null, imageUrl: null, role: 'admin', lastSeenAt: null, createdAt: new Date() }),
    ),
    ...overrides.users,
  } as UserRepository;
  return { tickets, audit, users };
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
    const call = vi.mocked(deps.tickets.update).mock.calls[0]![1] as { notes: string };
    expect(call.notes.length).toBe(10_000);
  });

  it('truncates notes at code-point boundaries without splitting surrogate pairs', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const longNote = '😀'.repeat(5000) + 'x'.repeat(5001);
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, notes: '' }),
      },
    });
    await updateTicket(
      { ticketId: 'TKT-1001', note: longNote, actorId: 'user_1' },
      deps,
    );
    const call = vi.mocked(deps.tickets.update).mock.calls[0]![1] as { notes: string };
    const notes = call.notes;
    for (let i = 0; i < notes.length; i++) {
      const code = notes.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(notes.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(notes.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
        i += 1;
      } else {
        expect(code).toBeLessThan(0xd800);
      }
    }
    expect([...notes].length).toBeLessThanOrEqual(10_000);
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

  it('rejects assigning to an unknown user', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, assignedTo: 'ghost' }),
      },
      users: {
        findByClerkId: vi.fn().mockResolvedValue(null),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', assignedTo: 'ghost', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
    }
    expect(deps.tickets.update).not.toHaveBeenCalled();
  });

  it('rejects assigning to a non-admin user', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, assignedTo: 'user_2' }),
      },
      users: {
        findByClerkId: vi.fn().mockResolvedValue({
          clerkUserId: 'user_2', email: 'u2@x.com', name: null, imageUrl: null,
          role: 'user', lastSeenAt: null, createdAt: new Date(),
        }),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', assignedTo: 'user_2', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
    }
    expect(deps.tickets.update).not.toHaveBeenCalled();
  });

  it('allows assigning to an admin user', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, notes: null };
    const updated = { ...existing, assignedTo: 'user_admin' };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', assignedTo: 'user_admin', actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(updated);
    }
  });

  it('allows unassigning without a users lookup', async () => {
    const existing = { ticketId: 'TKT-1001', status: 'created' as const, assignedTo: 'user_admin', notes: null };
    const updated = { ...existing, assignedTo: null };
    const deps = makeMockRepos({
      tickets: {
        findByTicketId: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue(updated),
      },
    });
    const result = await updateTicket(
      { ticketId: 'TKT-1001', assignedTo: null, actorId: 'user_1' },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.users.findByClerkId).not.toHaveBeenCalled();
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

  it('caps issue, name, and email fields', async () => {
    const deps = makeMockRepos();
    await createTicket(
      {
        userId: 'user_1',
        name: 'n'.repeat(200),
        email: 'e'.repeat(300) + '@x.com',
        issue: 'i'.repeat(5000),
      },
      deps,
    );
    expect(deps.tickets.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'n'.repeat(100),
        email: 'e'.repeat(254),
        issue: 'i'.repeat(4000),
      }),
    );
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
