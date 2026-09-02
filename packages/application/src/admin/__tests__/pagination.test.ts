import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@app/domain';
import type {
  AdminListCursor,
  AuditLog,
  ChunkRepository,
  CursorContext,
  DocumentRepository,
  ListCursorCodec,
  ListCursorPayload,
  TicketRepository,
  UserRepository,
} from '@app/domain';
import { listDocuments } from '../documents';
import { listTickets } from '../tickets';
import { listAudit } from '../list-audit';
import { listUsers } from '../../auth/users';

const timestamp = new Date('2026-04-01T12:00:00.000Z');
const pageInfo = { nextCursor: 'next-cursor', previousCursor: 'previous-cursor' };

function makeCursorCodec(): ListCursorCodec {
  const payloads = new Map<string, AdminListCursor>();
  let sequence = 0;
  return {
    encode(payload: ListCursorPayload): string {
      const token = `signed-test-cursor-${sequence++}`;
      payloads.set(token, payload);
      return token;
    },
    decode(value: string, context: CursorContext) {
      const payload = payloads.get(value);
      if (!payload || payload.kind !== context.resource) {
        return { kind: 'invalid', reason: 'malformed' };
      }
      return {
        kind: 'valid',
        payload: {
          ...payload,
          filterFingerprint: context.filterFingerprint,
          sort: context.sort,
        },
      };
    },
  };
}

const cursorCodec = makeCursorCodec();

function cursorToken(payload: AdminListCursor): string {
  return cursorCodec.encode({ ...payload, filterFingerprint: 'test-binding', sort: 'test-sort' });
}

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
        cursorCodec,
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
        cursor: cursorToken({ kind: 'documents', sortAt: timestamp, id: 4, total: 20 }),
      },
      {
        tickets: { list: vi.fn() } as unknown as TicketRepository,
        users,
        cursorCodec,
      },
    );

    expectValidation(result);
  });

  it('returns repository cursors for users and omits the compatibility offset', async () => {
    const list = vi.fn().mockResolvedValue({ rows: [], total: 2, ...pageInfo });
    const result = await listUsers(
      { cursor: cursorToken({ kind: 'users', sortAt: timestamp, clerkUserId: 'user_1', total: 20 }) },
      { users: adminUserRepository({ list }), cursorCodec },
    );

    expect(result).toEqual({ ok: true, value: { users: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      search: undefined,
      limit: 25,
      cursor: expect.objectContaining({ kind: 'users', sortAt: timestamp, clerkUserId: 'user_1', total: 20 }),
      cursorCodec,
      cursorContext: expect.objectContaining({ resource: 'users' }),
    });
  });

  it('returns repository cursors for tickets', async () => {
    const list = vi.fn().mockResolvedValue({ rows: [], total: 2, ...pageInfo });
    const result = await listTickets(
      { actorId: 'admin_1', before: cursorToken({ kind: 'tickets', sortAt: timestamp, id: 4, total: 20 }) },
      { tickets: { list } as unknown as TicketRepository, users: adminUserRepository(), cursorCodec },
    );

    expect(result).toEqual({ ok: true, value: { tickets: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      status: undefined,
      assignee: undefined,
      search: undefined,
      limit: 25,
      before: expect.objectContaining({ kind: 'tickets', sortAt: timestamp, id: 4, total: 20 }),
      cursorCodec,
      cursorContext: expect.objectContaining({ resource: 'tickets' }),
    });
  });

  it('returns repository cursors for documents', async () => {
    const list = vi.fn().mockResolvedValue({ documents: [], total: 2, ...pageInfo });
    const result = await listDocuments(
      { actorId: 'admin_1', before: cursorToken({ kind: 'documents', sortAt: timestamp, id: 4, total: 20 }) },
      {
        documents: { list } as unknown as DocumentRepository,
        chunks: { countForDocuments: vi.fn().mockResolvedValue(new Map()) } as unknown as ChunkRepository,
        users: adminUserRepository(),
        cursorCodec,
      },
    );

    expect(result).toEqual({ ok: true, value: { documents: [], total: 2, ...pageInfo } });
    expect(list).toHaveBeenCalledWith({
      search: undefined,
      includeDeleted: false,
      limit: 25,
      before: expect.objectContaining({ kind: 'documents', sortAt: timestamp, id: 4, total: 20 }),
      cursorCodec,
      cursorContext: expect.objectContaining({ resource: 'documents' }),
    });
  });

  it('returns repository cursors for audit events', async () => {
    const list = vi.fn().mockResolvedValue({ events: [], total: 2, ...pageInfo });
    const result = await listAudit(
      { actorId: 'admin_1', cursor: cursorToken({ kind: 'audit', sortAt: timestamp, id: 4, total: 20 }) },
      { audit: { list } as unknown as AuditLog, users: adminUserRepository(), cursorCodec },
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
      cursor: expect.objectContaining({ kind: 'audit', sortAt: timestamp, id: 4, total: 20 }),
      cursorCodec,
      cursorContext: expect.objectContaining({ resource: 'audit' }),
    });
  });
});
