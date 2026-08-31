import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ValidationError, logger } from '@app/domain';
import {
  insertDocument,
  listDocuments,
  getChunksByIds,
  getChunksByDocAndRange,
  getChunksByDocAndRanges,
  searchChunksByVector,
  searchChunksByLexical,
  auditRepo,
  createUserRepo,
  ticketRepo,
  userRepo,
} from '../repositories';
import { enforceNeonTlsVerification, isNeonUrl, redactDatabaseUrl } from '../pool';
import { VECTOR_DIM } from '../schema-vector';

const dialect = new PgDialect();
const paginationTimestamp = new Date('2026-04-01T12:00:00.000Z');
const timestamp = paginationTimestamp;

function makeExecuteClient(rows: unknown[]) {
  const executed: SQL[] = [];
  const client = {
    execute(query: SQL) {
      executed.push(query);
      return Promise.resolve({ rows });
    },
  };
  return { client: client as never, executed };
}

function queryOf(executed: SQL[]) {
  return dialect.sqlToQuery(executed[executed.length - 1]!);
}

describe('getChunksByIds', () => {
  it('emits a parameterized IN over the aliased column, never the quoted table', async () => {
    const { client, executed } = makeExecuteClient([]);
    const result = await getChunksByIds([1, 2, 3], client);
    expect(result).toEqual([]);
    const q = queryOf(executed);
    expect(q.sql).toContain('c.id IN ($1, $2, $3)');
    expect(q.sql).not.toContain('"chunks"."id"');
    expect(q.params).toEqual([1, 2, 3]);
  });

  it('returns an empty list without executing when no ids are given', async () => {
    const { client, executed } = makeExecuteClient([]);
    await expect(getChunksByIds([], client)).resolves.toEqual([]);
    expect(executed).toHaveLength(0);
  });
});

describe('getChunksByDocAndRange / getChunksByDocAndRanges', () => {
  const ROW = {
    id: 1, documentId: 7, fileName: 'a.pdf', page: null, sectionTitle: null,
    source: null, title: null, content: 'alpha', parentChunkId: null, chunkIndex: 0, similarity: 0,
  };

  it('filters by the aliased c.document_id in the singular variant', async () => {
    const { client, executed } = makeExecuteClient([ROW]);
    const result = await getChunksByDocAndRange(7, 0, 4, client);
    expect(result).toHaveLength(1);
    const q = queryOf(executed);
    expect(q.sql).toContain('c.document_id = $1');
    expect(q.sql).toContain('c.chunk_index >= $2');
    expect(q.sql).toContain('c.chunk_index <= $3');
    expect(q.sql).not.toContain('"chunks"."document_id"');
    expect(q.params).toEqual([7, 0, 4]);
  });

  it('compiles OR-ed aliased conditions with placeholders for a range batch', async () => {
    const { client, executed } = makeExecuteClient([]);
    const result = await getChunksByDocAndRanges(
      [{ documentId: 7, start: 0, end: 5 }, { documentId: 9, start: 2, end: 3 }],
      client,
    );
    expect(result.size).toBe(0);
    const q = queryOf(executed);
    expect(q.sql).toContain('c.document_id = $1');
    expect(q.sql).toContain('c.chunk_index <= $3');
    expect(q.sql).toContain('c.chunk_index >= $5');
    expect(q.sql).not.toContain('"chunks"."document_id"');
    expect(q.params).toEqual([7, 0, 5, 9, 2, 3]);
  });

  it('groups returned rows into per-range keyed buckets', async () => {
    const { client } = makeExecuteClient([
      { ...ROW, id: 1, documentId: 7, content: 'alpha', chunkIndex: 0 },
      { ...ROW, id: 2, documentId: 9, content: 'beta', chunkIndex: 4 },
    ]);
    const map = await getChunksByDocAndRanges(
      [{ documentId: 7, start: 0, end: 5 }, { documentId: 9, start: 3, end: 5 }],
      client,
    );
    expect([...map.keys()]).toEqual(['7:0:5', '9:3:5']);
    expect(map.get('7:0:5')!.map((c) => c.content)).toEqual(['alpha']);
    expect(map.get('9:3:5')!.map((c) => c.content)).toEqual(['beta']);
  });
});

describe('searchChunksByVector', () => {
  it('bounds the vector as a parameter and filters candidates to non-deleted documents', async () => {
    const { client, executed } = makeExecuteClient([]);
    const result = await searchChunksByVector(
      Array.from({ length: VECTOR_DIM }, () => 0.1),
      { threshold: 0.55, limit: 10 },
      client,
    );
    expect(result).toEqual([]);
    const q = queryOf(executed);
    const s = q.sql.toLowerCase();
    expect(s).toContain('with candidates as');
    expect(s).toContain('join documents doc on doc.id = ch.document_id');
    expect(s).toContain('doc.deleted_at is null');
    expect(s).toContain("ch.kind <> 'parent'");
    expect(s).toContain('::vector');
    expect(typeof q.params[0]).toBe('string');
    expect((q.params[0] as string).startsWith('[0.1,')).toBe(true);
    expect(q.params).toEqual(expect.arrayContaining([0.55, 10]));
  });

  it('rejects wrong-dimension or non-finite embeddings before executing', async () => {
    const { client, executed } = makeExecuteClient([]);
    await expect(
      searchChunksByVector([0.1], { threshold: 0.5, limit: 5 }, client),
    ).rejects.toThrow(/expected 768 dimensions/);
    await expect(
      searchChunksByVector([Number.NaN], { threshold: 0.5, limit: 5 }, client),
    ).rejects.toThrow(/finite numbers/);
    expect(executed).toHaveLength(0);
  });
});

describe('searchChunksByLexical', () => {
  it('compiles plainto_tsquery with a bound query parameter', async () => {
    const { client, executed } = makeExecuteClient([]);
    const result = await searchChunksByLexical('broken vector', { limit: 5 }, client);
    expect(result).toEqual([]);
    const q = queryOf(executed);
    expect(q.sql).toContain("plainto_tsquery('english',");
    expect(q.sql).toContain('c.tsv @@');
    expect(q.params).toEqual(expect.arrayContaining(['broken vector']));
  });

  it('returns an empty result without executing for blank queries', async () => {
    const { client, executed } = makeExecuteClient([]);
    await expect(searchChunksByLexical('   ', { limit: 5 }, client)).resolves.toEqual([]);
    expect(executed).toHaveLength(0);
  });
});

describe('insertDocument', () => {
  type DocRow = { id: number; fileName: string; fileHash: string; uploadedBy: string; deletedAt: Date | null };

  function makeDocClient() {
    const doc: DocRow = { id: 42, fileName: 'x.pdf', fileHash: 'h1', uploadedBy: 'u1', deletedAt: null };
    const state: {
      existing: DocRow | null | undefined;
      uniqueViolationOnce: boolean;
      findFirsts: number;
      inserts: number;
      updates: number;
      deletes: number;
      lastUpdate: Record<string, unknown> | null;
    } = {
      existing: undefined,
      uniqueViolationOnce: false,
      findFirsts: 0,
      inserts: 0,
      updates: 0,
      deletes: 0,
      lastUpdate: null,
    };
    const client = {
      query: {
        documents: {
          findFirst: async () => {
            state.findFirsts++;
            return state.existing;
          },
        },
      },
      update: vi.fn(() => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            state.updates++;
            state.lastUpdate = patch;
            return { returning: async () => [doc] };
          },
        }),
      })),
      delete: vi.fn(() => ({
        where: async () => {
          state.deletes++;
        },
      })),
      insert: vi.fn(() => ({
        values: () => {
          if (state.uniqueViolationOnce) {
            state.uniqueViolationOnce = false;
            state.existing = doc;
            throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
          }
          return {
            returning: async () => {
              state.inserts++;
              return [doc];
            },
          };
        },
      })),
    };
    return { client: client as never, state, doc };
  }

  it('updates the live row in place when the file already exists', async () => {
    const { client, state, doc } = makeDocClient();
    state.existing = doc;
    const row = await insertDocument({ fileName: 'x.pdf', fileHash: 'h2', uploadedBy: 'u2' }, client);
    expect(row.id).toBe(42);
    expect(state.inserts).toBe(0);
    expect(state.updates).toBe(1);
    expect(state.deletes).toBe(0);
    expect(state.lastUpdate).toMatchObject({ fileHash: 'h2', uploadedBy: 'u2' });
  });

  it('resurrects a soft-deleted row without deleting stable chunks before replacement', async () => {
    const { client, state, doc } = makeDocClient();
    state.existing = { ...doc, deletedAt: new Date('2026-01-01T00:00:00Z') };
    const row = await insertDocument({ fileName: 'x.pdf', fileHash: 'h2', uploadedBy: 'u2' }, client);
    expect(row.id).toBe(42);
    expect(state.deletes).toBe(0);
    expect(state.updates).toBe(1);
    expect(state.inserts).toBe(0);
    expect(state.lastUpdate).toMatchObject({
      fileHash: 'h2',
      uploadedBy: 'u2',
      deletedAt: null,
      ingestStatus: 'done',
    });
  });

  it('inserts a brand-new document when no row exists', async () => {
    const { client, state, doc } = makeDocClient();
    state.existing = null;
    const row = await insertDocument({ fileName: 'fresh.pdf', fileHash: 'h', uploadedBy: 'u' }, client);
    expect(row.id).toBe(doc.id);
    expect(state.inserts).toBe(1);
    expect(state.updates).toBe(0);
    expect(state.deletes).toBe(0);
  });

  it('does not retry a unique violation on the same client', async () => {
    const { client, state } = makeDocClient();
    state.existing = null;
    state.uniqueViolationOnce = true;
    await expect(
      insertDocument({ fileName: 'x.pdf', fileHash: 'h2', uploadedBy: 'u2' }, client),
    ).rejects.toThrow('duplicate key value violates unique constraint');
    expect(state.findFirsts).toBe(1);
    expect(state.inserts).toBe(0);
    expect(state.updates).toBe(0);
    expect(state.deletes).toBe(0);
  });
});

describe('auditRepo.list', () => {
  function makeSelectClient() {
    type SelectChain = {
      from: () => SelectChain;
      leftJoin: () => SelectChain;
      where: () => SelectChain;
      orderBy: () => SelectChain;
      limit: () => SelectChain;
      offset: () => Promise<never[]>;
    };
    const q: SelectChain = {
      from: () => q,
      leftJoin: () => q,
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      offset: async () => [],
    };
    return { select: () => q } as never;
  }

  it('rejects an invalid kind', async () => {
    const client = makeSelectClient();
    const err = await auditRepo.list({ kind: 'bogus' as never, limit: 10, offset: 0 }, client).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/Invalid audit kind: bogus/);
  });

  it('rejects kind=document combined with a ticketId filter', async () => {
    const client = makeSelectClient();
    const err = await auditRepo.list({ kind: 'document', ticketId: 'T-1', limit: 10, offset: 0 }, client).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/kind=document and ticketId/);
  });

  it('rejects kind=ticket combined with a documentId filter', async () => {
    const client = makeSelectClient();
    const err = await auditRepo.list({ kind: 'ticket', documentId: 5, limit: 10, offset: 0 }, client).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/kind=ticket and documentId/);
  });

  it('accepts non-conflicting filters and returns the queried rows', async () => {
    const client = makeSelectClient();
    const result = await auditRepo.list({ kind: 'document', documentId: 5, limit: 20, offset: 0 }, client);
    expect(result).toEqual({ events: [], total: 0, nextCursor: null, previousCursor: null });
    await expect(auditRepo.list({ kind: 'ticket', ticketId: 'T-1', limit: 10, offset: 0 }, client)).resolves.toEqual({
      events: [],
      total: 0,
      nextCursor: null,
      previousCursor: null,
    });
  });
});

describe('keyset list pagination', () => {
  type QueryCall = {
    where?: unknown;
    orderBy: unknown[];
    limit?: number;
  };

  function makePaginatedSelectClient(dataRows: unknown[], count = dataRows.length) {
    const calls: QueryCall[] = [];
    let selectIndex = 0;

    function makeChain(rows: unknown[]): {
      from: () => ReturnType<typeof makeChain>;
      leftJoin: () => ReturnType<typeof makeChain>;
      where: (condition?: unknown) => ReturnType<typeof makeChain>;
      orderBy: (...orders: unknown[]) => ReturnType<typeof makeChain>;
      limit: (value: number) => ReturnType<typeof makeChain>;
      offset: (value: number) => Promise<unknown[]>;
      then: (resolve: (value: unknown[]) => unknown) => Promise<unknown>;
    } {
      const call: QueryCall = { orderBy: [] };
      calls.push(call);
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: (condition?: unknown) => {
          call.where = condition;
          return chain;
        },
        orderBy: (...orders: unknown[]) => {
          call.orderBy = orders;
          return chain;
        },
        limit: (value: number) => {
          call.limit = value;
          return chain;
        },
        offset: async () => rows,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    }

    const client = {
      select: () => {
        const rows = selectIndex++ === 0 ? dataRows : [{ count }];
        return makeChain(rows);
      },
    };
    return { client: client as never, calls };
  }

  it('keeps the nearest rows when a backward document query has an extra row', async () => {
    const { client, calls } = makePaginatedSelectClient([
      { id: 4, uploadedAt: timestamp },
      { id: 5, uploadedAt: timestamp },
      { id: 6, uploadedAt: timestamp },
    ], 6);
    const result = await listDocuments({
      limit: 2,
      before: { kind: 'documents', sortAt: timestamp, id: 3, total: 6 },
    }, client);

    expect(result.documents.map((row) => row.id)).toEqual([5, 4]);
    expect(result.total).toBe(6);
    expect(result.nextCursor).not.toBeNull();
    expect(result.previousCursor).not.toBeNull();
    expect(calls[0]?.limit).toBe(3);
    expect(calls).toHaveLength(1);
  });

  it('keeps the nearest rows when a backward ticket query has an extra row', async () => {
    const { client } = makePaginatedSelectClient([
      { id: 4, createdAt: timestamp },
      { id: 5, createdAt: timestamp },
      { id: 6, createdAt: timestamp },
    ], 6);
    const result = await ticketRepo.list({
      limit: 2,
      before: { kind: 'tickets', sortAt: timestamp, id: 3, total: 6 },
    }, client);

    expect(result.rows.map((row) => row.id)).toEqual([5, 4]);
    expect(result.nextCursor).not.toBeNull();
    expect(result.previousCursor).not.toBeNull();
  });

  it('keeps the nearest rows when a backward user query has an extra row', async () => {
    const { client } = makePaginatedSelectClient([
      { clerkUserId: 'user_3', createdAt: timestamp },
      { clerkUserId: 'user_2', createdAt: timestamp },
      { clerkUserId: 'user_1', createdAt: timestamp },
    ], 6);
    const result = await userRepo.list({
      limit: 2,
      before: { kind: 'users', sortAt: timestamp, clerkUserId: 'user_4', total: 6 },
    }, client);

    expect(result.rows.map((row) => row.clerkUserId)).toEqual(['user_2', 'user_3']);
    expect(result.nextCursor).not.toBeNull();
    expect(result.previousCursor).not.toBeNull();
  });

  it('keeps the nearest rows when a backward audit query has an extra row', async () => {
    const { client } = makePaginatedSelectClient([
      { id: 4, at: timestamp, kind: 'document', action: 'created', actorId: null },
      { id: 5, at: timestamp, kind: 'document', action: 'created', actorId: null },
      { id: 6, at: timestamp, kind: 'document', action: 'created', actorId: null },
    ], 6);
    const result = await auditRepo.list({
      limit: 2,
      before: { kind: 'audit', sortAt: timestamp, id: 3, total: 6 },
    }, client);

    expect(result.events.map((event) => event.id)).toEqual([5, 4]);
    expect(result.nextCursor).not.toBeNull();
    expect(result.previousCursor).not.toBeNull();
  });

  it('passes compound cursor predicates to forward queries', async () => {
    const { client, calls } = makePaginatedSelectClient([
      { id: 2, uploadedAt: timestamp },
    ], 2);
    await listDocuments({
      limit: 2,
      cursor: { kind: 'documents', sortAt: timestamp, id: 3, total: 2 },
    }, client);

    const query = dialect.sqlToQuery(calls[0]!.where as SQL);
    expect(query.sql).toContain('"documents"."uploaded_at" < $1');
    expect(query.sql).toContain('"documents"."id" < $3');
    expect(calls[0]!.orderBy).toHaveLength(2);
  });
});

describe('userRepo.countAdminsForUpdate', () => {
  it('locks the admin rows in a subquery so the aggregate count is valid PostgreSQL', async () => {
    const { client, executed } = makeExecuteClient([{ count: 2 }]);
    const result = await createUserRepo(client).countAdminsForUpdate();
    expect(result).toBe(2);
    const s = queryOf(executed).sql.toLowerCase();
    expect(s).toContain('count(*)::int');
    expect(s).toContain('for update');
    expect(s).toContain('(select 1 from "users" where "users"."role" = \'admin\' for update)');
    expect(s).not.toContain('for update\n');
  });
});

describe('isNeonUrl', () => {
  it('returns false for an empty connection string', () => {
    expect(isNeonUrl('')).toBe(false);
  });

  it('returns false for a plain postgres URL', () => {
    expect(isNeonUrl('postgres://user:pass@localhost:5432/db')).toBe(false);
  });

  it('returns true for a neon.tech host', () => {
    expect(isNeonUrl('postgres://user:pass@ep-thing-123.us-east-1.aws.neon.tech/db?sslmode=require')).toBe(true);
  });

  it('returns true for a neon.app host', () => {
    expect(isNeonUrl('postgres://user:pass@ep-thing-123.us-east-1.aws.neon.app/db')).toBe(true);
  });

  it('throws a descriptive error for a malformed URL', () => {
    expect(() => isNeonUrl('not a url')).toThrow(/Invalid DATABASE_URL/);
  });
});

describe('enforceNeonTlsVerification', () => {
  it.each(['prefer', 'require', 'verify-ca'])('upgrades Neon sslmode=%s to verify-full', (sslMode) => {
    const result = enforceNeonTlsVerification(
      `postgres://user:pass@ep-example-pooler.us-east-1.aws.neon.tech/db?sslmode=${sslMode}`,
    );
    expect(new URL(result).searchParams.get('sslmode')).toBe('verify-full');
  });

  it('does not change non-Neon connection strings', () => {
    const url = 'postgres://user:pass@localhost:5432/db?sslmode=require';
    expect(enforceNeonTlsVerification(url)).toBe(url);
  });
});

describe('redactDatabaseUrl', () => {
  it('strips the password from a valid URL via the URL parser', () => {
    expect(redactDatabaseUrl('postgres://user:secret@host:5432/db')).toBe('postgres://user@host:5432/db');
  });

  it('redacts credentials from an unparseable URL without touching host or db', () => {
    expect(redactDatabaseUrl('postgres user:secret@host:5432/db')).toBe('postgres user:****@host:5432/db');
  });

  it('keeps URLs without credentials unchanged', () => {
    expect(redactDatabaseUrl('postgres://host:5432/db')).toBe('postgres://host:5432/db');
    expect(redactDatabaseUrl('not a url')).toBe('not a url');
  });

  it('never leaks the password through the Invalid DATABASE_URL error', () => {
    const err = (() => {
      try {
        isNeonUrl('postgres user:secret@host:5432/db');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/Invalid DATABASE_URL: "postgres user:\*\*\*\*@host:5432\/db"/);
    expect(err?.message).not.toContain('secret');
  });
});

describe('ILIKE search escaping', () => {
  function makeWhereCaptureClient() {
    const wheres: Array<SQL | undefined> = [];
    type Chain = {
      from: () => Chain;
      leftJoin: () => Chain;
      where: (where?: SQL) => Chain;
      orderBy: () => Chain;
      limit: () => Chain;
      offset: () => Promise<unknown[]>;
      [Symbol.iterator]: () => Iterator<never>;
    };
    const chain: Chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: (where?: SQL) => {
        wheres.push(where);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: async () => [],
      [Symbol.iterator]: () => [][Symbol.iterator](),
    };
    const client = { select: () => chain };
    return { client: client as never, lastWhere: () => wheres[wheres.length - 1]! };
  }

  it('escapes backslash, % and _ in document searches so they match literally', async () => {
    const { client, lastWhere } = makeWhereCaptureClient();
    await listDocuments({ search: String.raw`a\b%_c`, limit: 10, offset: 0 }, client);
    const q = dialect.sqlToQuery(lastWhere());
    expect(q.params).toContain(String.raw`%a\\b\%\_c%`);
    expect(q.params).not.toContain(String.raw`%a\b%_c%`);
    expect(q.sql).toContain('ilike');
    expect(q.sql).not.toContain('\\');
  });

  it('escapes backslash, % and _ in ticket searches so they match literally', async () => {
    const { client, lastWhere } = makeWhereCaptureClient();
    await ticketRepo.list({ search: String.raw`50%\off`, limit: 10, offset: 0 }, client);
    const q = dialect.sqlToQuery(lastWhere());
    expect(q.params).toContain(String.raw`%50\%\\off%`);
    expect(q.params).not.toContain(String.raw`%50%\off%`);
    expect(q.sql).toContain('ilike');
    expect(q.sql).not.toContain('\\');
  });

  it('escapes backslash, % and _ in user searches so they match literally', async () => {
    const { client, lastWhere } = makeWhereCaptureClient();
    await userRepo.list({ search: String.raw`\_\%`, limit: 10, offset: 0 }, client);
    const q = dialect.sqlToQuery(lastWhere());
    expect(q.params).toContain(String.raw`%\\\_\\\%%`);
    expect(q.params).not.toContain(String.raw`%\_\%%`);
    expect(q.sql).toContain('ilike');
    expect(q.sql).not.toContain('\\');
  });
});

describe('userRepo.upsertFromClerk email-conflict handling', () => {
  type UserRowLike = {
    clerkUserId: string;
    email: string;
    name: string | null;
    imageUrl: string | null;
    role: 'admin' | 'user';
    lastSeenAt: Date | null;
    createdAt: Date;
  };

  const VICTIM: UserRowLike = {
    clerkUserId: 'user_victim',
    email: 'shared@x.com',
    name: 'Victim',
    imageUrl: null,
    role: 'admin',
    lastSeenAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  const EMPTY_HISTORY = {
    documents: false,
    tickets: false,
    chatEvents: false,
    chatConversations: false,
    qualityReviews: false,
    auditEvents: false,
    appSettings: false,
  } as const;

  function makeClerkClient(state: {
    existingUser: UserRowLike | null;
    conflictOnce?: boolean;
    wrappedConflict?: boolean;
    history: Record<keyof typeof EMPTY_HISTORY, boolean>;
    insertResult?: UserRowLike;
    rebindResult?: UserRowLike;
  }) {
    let updatePatch: Record<string, unknown> | null = null;
    let updateCalls = 0;
    const client = {
      query: {
        users: { findFirst: async () => state.existingUser },
        documents: { findFirst: async () => (state.history.documents ? {} : null) },
        tickets: { findFirst: async () => (state.history.tickets ? {} : null) },
        chatEvents: { findFirst: async () => (state.history.chatEvents ? {} : null) },
        chatConversations: { findFirst: async () => (state.history.chatConversations ? {} : null) },
        qualityReviews: { findFirst: async () => (state.history.qualityReviews ? {} : null) },
        auditEvents: { findFirst: async () => (state.history.auditEvents ? {} : null) },
        appSettings: { findFirst: async () => (state.history.appSettings ? {} : null) },
      },
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              if (state.conflictOnce) {
                state.conflictOnce = false;
                const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
                  code: '23505',
                  constraint: 'users_email_unique',
                });
                if (state.wrappedConflict) throw { cause: pgErr };
                throw pgErr;
              }
              return [state.insertResult ?? VICTIM];
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            updateCalls++;
            updatePatch = patch;
            return { returning: async () => [state.rebindResult ?? { ...VICTIM, clerkUserId: 'user_attacker' }] };
          },
        }),
      }),
    };
    return {
      client: client as never,
      updatePatch: () => updatePatch,
      updateCalls: () => updateCalls,
    };
  }

  it('upserts by clerkUserId on the normal path without touching the rebind logic', async () => {
    const { client, updateCalls } = makeClerkClient({
      existingUser: null,
      history: EMPTY_HISTORY,
      insertResult: { ...VICTIM, clerkUserId: 'user_fresh', email: 'fresh@x.com', role: 'user' },
    });
    const row = await userRepo.upsertFromClerk(
      { clerkUserId: 'user_fresh', email: 'fresh@x.com', role: 'user' },
      client,
    );
    expect(row.clerkUserId).toBe('user_fresh');
    expect(updateCalls()).toBe(0);
  });

  it.each(Object.keys(EMPTY_HISTORY) as Array<keyof typeof EMPTY_HISTORY>)(
    'fails closed on an email conflict when the existing row owns %s history',
    async (table) => {
      const errorSpy = vi.spyOn(logger, 'error');
      const { client, updateCalls } = makeClerkClient({
        existingUser: VICTIM,
        conflictOnce: true,
        history: { ...EMPTY_HISTORY, [table]: true },
      });
      const err = await userRepo
        .upsertFromClerk({ clerkUserId: 'user_attacker', email: 'shared@x.com', role: 'user', emailVerified: true }, client)
        .catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/owns data; refusing/);
      expect(updateCalls()).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[userRepo]'),
        expect.objectContaining({ email: 'shared@x.com', existingClerkUserId: 'user_victim' }),
      );
      errorSpy.mockRestore();
    },
  );

  it('refuses to rebind an unverified email even when the account is history-free', async () => {
    const { client, updateCalls } = makeClerkClient({
      existingUser: VICTIM,
      conflictOnce: true,
      wrappedConflict: true,
      history: EMPTY_HISTORY,
    });
    const err = await userRepo
      .upsertFromClerk({ clerkUserId: 'user_attacker', email: 'shared@x.com', role: 'user' }, client)
      .catch((e) => e);
    expect((err as Error).message).toMatch(/verification is not confirmed; refusing/);
    expect(updateCalls()).toBe(0);
  });

  it('rebinds only a verified, history-free account and preserves its role', async () => {
    const { client, updatePatch, updateCalls } = makeClerkClient({
      existingUser: VICTIM,
      conflictOnce: true,
      history: EMPTY_HISTORY,
      rebindResult: { ...VICTIM, clerkUserId: 'user_attacker', name: 'New', imageUrl: 'https://x/y.png' },
    });
    const row = await userRepo.upsertFromClerk(
      {
        clerkUserId: 'user_attacker',
        email: 'shared@x.com',
        name: 'New',
        imageUrl: 'https://x/y.png',
        role: 'user',
        emailVerified: true,
      },
      client,
    );
    expect(updateCalls()).toBe(1);
    expect(updatePatch()).toMatchObject({
      clerkUserId: 'user_attacker',
      email: 'shared@x.com',
      name: 'New',
      imageUrl: 'https://x/y.png',
    });
    expect(updatePatch()).not.toHaveProperty('role');
    expect(row.clerkUserId).toBe('user_attacker');
    expect(row.role).toBe('admin');
  });

  it('fails closed when the conflicting email row disappears mid-sync', async () => {
    const { client, updateCalls } = makeClerkClient({
      existingUser: null,
      conflictOnce: true,
      history: EMPTY_HISTORY,
    });
    const err = await userRepo
      .upsertFromClerk({ clerkUserId: 'user_attacker', email: 'shared@x.com', role: 'user', emailVerified: true }, client)
      .catch((e) => e);
    expect((err as Error).message).toMatch(/refusing to reassign/);
    expect(updateCalls()).toBe(0);
  });

  it('returns the existing row unchanged when it already belongs to the caller', async () => {
    const { client, updateCalls } = makeClerkClient({
      existingUser: VICTIM,
      conflictOnce: true,
      history: EMPTY_HISTORY,
    });
    const row = await userRepo.upsertFromClerk(
      { clerkUserId: 'user_victim', email: 'shared@x.com', role: 'user', emailVerified: true },
      client,
    );
    expect(row.clerkUserId).toBe('user_victim');
    expect(updateCalls()).toBe(0);
  });
});
