import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ValidationError } from '@app/domain';
import {
  insertDocument,
  getChunksByIds,
  getChunksByDocAndRange,
  getChunksByDocAndRanges,
  searchChunksByVector,
  searchChunksByLexical,
  auditRepo,
} from '../repositories';
import { isNeonUrl } from '../pool';
import { VECTOR_DIM } from '../schema-vector';

const dialect = new PgDialect();

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

  it('resurrects a soft-deleted row by deleting chunks then restoring the document', async () => {
    const { client, state, doc } = makeDocClient();
    state.existing = { ...doc, deletedAt: new Date('2026-01-01T00:00:00Z') };
    const row = await insertDocument({ fileName: 'x.pdf', fileHash: 'h2', uploadedBy: 'u2' }, client);
    expect(row.id).toBe(42);
    expect(state.deletes).toBe(1);
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

  it('retries once on a unique-violation and resolves via the update path', async () => {
    const { client, state } = makeDocClient();
    state.existing = null;
    state.uniqueViolationOnce = true;
    const row = await insertDocument({ fileName: 'x.pdf', fileHash: 'h2', uploadedBy: 'u2' }, client);
    expect(row.id).toBe(42);
    expect(state.findFirsts).toBe(2);
    expect(state.inserts).toBe(0);
    expect(state.updates).toBe(1);
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
    expect(result).toEqual({ events: [], total: 0 });
    await expect(auditRepo.list({ kind: 'ticket', ticketId: 'T-1', limit: 10, offset: 0 }, client)).resolves.toEqual({
      events: [],
      total: 0,
    });
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