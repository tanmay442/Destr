import { describe, expect, it, vi } from 'vitest';
import { ValidationError, encodeListCursor } from '@app/domain';
import type { AuditLog, ChunkRepository, DocumentRepository, TicketRepository, UserRepository } from '@app/domain';
import { listDocuments } from '../documents';
import { listTickets } from '../tickets';
import { listAudit } from '../list-audit';
import { listUsers } from '../../auth/users';

const timestamp = new Date('2026-04-01T12:00:00.000Z');
const pageInfo = { nextCursor: 'next-cursor', previousCursor: 'previous-cursor' };

function adminUserRepository(overrides: Partial<UserRepository> = {}): UserRepository {
  return {
    findByClerkId: vi.fn().mockResolvedValue({
      clerkUserId: 'admin_1',
      email: 'admin@example.test',
      name: 'Admin',
      imageUrl: null,
      role: 'admin',
      lastSeenAt: null,
      createdAt: timestamp,
    }),
    findByIds: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0, ...pageInfo }),
    upsertFromClerk: vi.fn(),
    setRole: vi.fn(),
    touchLastSeen: vi.fn(),
    countAll: vi.fn(),
    countAdmins: vi.fn(),
    countAdminsForUpdate: vi.fn(),
    ...overrides,
  };
}

function expectValidation(result: { ok: boolean; error?: unknown }): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
}

describe('admin list pagination application boundary', () => {
  it('rejects a malformed document cursor before the repository is called', async () => {
    const list = vi.fn();
    const users = adminUserRepository();
    const result = await listDocuments(
      { actorId: 'admin_1', cursor: 'malformed' },
      {
        documents: { list } as unknown as DocumentRepository,
        chunks: { countForDocuments: vi.fn() } as unknown as ChunkRepository,
        users,
      },
    );

    expectValidation(result);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a cursor for another resource kind', async () => {
    const users = adminUserRepository();
    const result = await listTickets(
      {
        actorId: 'admin_1',
        cursor: encodeListCursor({ kind: 'documents', sortAt: timestamp, id: 4 }),
      },
      {
        tickets: { list: vi.fn() } as unknown as TicketRepository,
        users,
      },
    );

    expectValidation(result);
  });

  it('returns repository cursors for users and omits the compatibility offset', async () => {
    const list = vi.fn().mockResolvedValue({ rows: [], total: 2, ...pageInfo });
    const result = await listUsers(
      { cursor: encodeListCursor({ kind: 'users', sortAt: timestamp, clerkUserId: 'user_1' }) },
      { users: adminUserRepository({ list }) },
    );

    expect(result).toEqual({ ok: true, value: { users: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      search: undefined,
      limit: 25,
      cursor: { kind: 'users', sortAt: timestamp, clerkUserId: 'user_1' },
    });
  });

  it('returns repository cursors for tickets', async () => {
    const list = vi.fn().mockResolvedValue({ rows: [], total: 2, ...pageInfo });
    const result = await listTickets(
      { actorId: 'admin_1', before: encodeListCursor({ kind: 'tickets', sortAt: timestamp, id: 4 }) },
      { tickets: { list } as unknown as TicketRepository, users: adminUserRepository() },
    );

    expect(result).toEqual({ ok: true, value: { tickets: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      status: undefined,
      assignee: undefined,
      search: undefined,
      limit: 25,
      before: { kind: 'tickets', sortAt: timestamp, id: 4 },
    });
  });

  it('returns repository cursors for documents', async () => {
    const list = vi.fn().mockResolvedValue({ documents: [], total: 2, ...pageInfo });
    const result = await listDocuments(
      { actorId: 'admin_1', before: encodeListCursor({ kind: 'documents', sortAt: timestamp, id: 4 }) },
      {
        documents: { list } as unknown as DocumentRepository,
        chunks: { countForDocuments: vi.fn().mockResolvedValue(new Map()) } as unknown as ChunkRepository,
        users: adminUserRepository(),
      },
    );

    expect(result).toEqual({ ok: true, value: { documents: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      search: undefined,
      includeDeleted: undefined,
      limit: 25,
      before: { kind: 'documents', sortAt: timestamp, id: 4 },
    });
  });

  it('returns repository cursors for audit events', async () => {
    const list = vi.fn().mockResolvedValue({ events: [], total: 2, ...pageInfo });
    const result = await listAudit(
      { actorId: 'admin_1', cursor: encodeListCursor({ kind: 'audit', sortAt: timestamp, id: 4 }) },
      { audit: { list } as unknown as AuditLog, users: adminUserRepository() },
    );

    expect(result).toEqual({ ok: true, value: { events: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      kind: undefined,
      action: undefined,
      actorId: undefined,
      from: undefined,
      to: undefined,
      documentId: undefined,
      ticketId: undefined,
      limit: 50,
      cursor: { kind: 'audit', sortAt: timestamp, id: 4 },
    });
  });
});
