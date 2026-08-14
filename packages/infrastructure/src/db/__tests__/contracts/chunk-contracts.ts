import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { VECTOR_DIM } from '../../schema-vector';
import { insertDocument, softDeleteDocument, deleteDocumentById } from '../../repositories';
import { ValidationError } from '@app/domain';
import type { ChunkRepository, ChunkStore, VectorSearch, LexicalSearch } from '@app/domain';
import type { Client } from '../../chunk-store';

export interface ChunkContractFactories {
  makeVector: (client: Client) => VectorSearch;
  makeLexical: (client: Client) => LexicalSearch;
  makeStore: (client: Client) => ChunkStore;
  makeComposite: (client: Client) => ChunkRepository;
}

interface Target {
  vector: VectorSearch;
  lexical: LexicalSearch;
  store: ChunkStore;
}

const dims = () => Array.from({ length: VECTOR_DIM }, () => 0);
const makeEmb = (d0: number, d1: number) => {
  const v = dims();
  v[0] = d0;
  v[1] = d1;
  return v;
};

async function rolledBack<T>(fn: (tx: Client) => Promise<T>): Promise<T> {
  let result!: T;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new Error('__CONTRACT_ROLLBACK__');
    });
  } catch (e) {
    if (e instanceof Error && e.message !== '__CONTRACT_ROLLBACK__') throw e;
  }
  return result;
}

async function seedDoc(
  store: ChunkStore,
  client: Client,
  rows: Array<{
    content: string;
    embedding: number[];
    chunkIndex?: number;
    kind?: 'parent' | 'child' | 'summary';
    parentChunkId?: number | null;
  }>,
): Promise<number> {
  const fileName = `contract-${randomUUID()}.pdf`;
  const doc = await insertDocument({ fileName, fileHash: randomUUID(), uploadedBy: 'contract-test' }, client);
  await store.insertMany(
    rows.map((r, i) => ({
      documentId: doc.id,
      content: r.content,
      embedding: r.embedding,
      chunkIndex: r.chunkIndex ?? i,
      kind: r.kind ?? 'child',
      parentChunkId: r.parentChunkId ?? null,
    })),
  );
  return doc.id;
}

function vectorSuite(target: (client: Client) => Target): void {
  describe('vector search', () => {
    it('ranks results by similarity descending and honors limit', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [
          { content: 'c1', embedding: makeEmb(1, 1) },
          { content: 'c2', embedding: makeEmb(1, 0.5) },
          { content: 'c3', embedding: makeEmb(1, 0) },
          { content: 'c4', embedding: makeEmb(1, -0.5) },
        ]);
        expect(docId).toBeGreaterThan(0);
        const limited = await t.vector.searchByVector(makeEmb(1, 1), { threshold: -1, limit: 2 });
        expect(limited.map((r) => r.content)).toEqual(['c1', 'c2']);
        expect(limited[0]!.similarity).toBeGreaterThan(limited[1]!.similarity);
        const all = await t.vector.searchByVector(makeEmb(1, 1), { threshold: -1, limit: 10 });
        expect(all.map((r) => r.content)).toEqual(['c1', 'c2', 'c3', 'c4']);
      });
    });

    it('applies the similarity threshold', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await seedDoc(t.store, tx, [
          { content: 'near', embedding: makeEmb(1, 1) },
          { content: 'far', embedding: makeEmb(1, -1) },
        ]);
        const narrow = await t.vector.searchByVector(makeEmb(1, 1), { threshold: 0.99, limit: 10 });
        expect(narrow.map((r) => r.content)).toEqual(['near']);
        const impossible = await t.vector.searchByVector(makeEmb(1, 1), { threshold: 1.01, limit: 10 });
        expect(impossible).toEqual([]);
      });
    });

    it('excludes parent chunks and honors the documentId filter', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docA = await seedDoc(t.store, tx, [
          { content: 'parent', kind: 'parent', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'childA', chunkIndex: 1, kind: 'child', parentChunkId: 0, embedding: makeEmb(1, 1) },
        ]);
        await seedDoc(t.store, tx, [{ content: 'childB', embedding: makeEmb(1, 1) }]);
        const all = await t.vector.searchByVector(makeEmb(1, 1), { threshold: -1, limit: 10 });
        expect(all.map((r) => r.content).sort()).toEqual(['childA', 'childB']);
        const filtered = await t.vector.searchByVector(makeEmb(1, 1), {
          threshold: -1,
          limit: 10,
          filter: { documentId: docA },
        });
        expect(filtered.map((r) => r.content)).toEqual(['childA']);
      });
    });

    it('excludes chunks of soft-deleted documents', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [{ content: 'gone', embedding: makeEmb(1, 1) }]);
        await softDeleteDocument(docId, new Date(), tx);
        const res = await t.vector.searchByVector(makeEmb(1, 1), { threshold: -1, limit: 10 });
        expect(res).toEqual([]);
      });
    });

    it('rejects invalid embeddings', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await expect(t.vector.searchByVector([], { threshold: 0, limit: 5 })).rejects.toThrow();
        await expect(t.vector.searchByVector([Number.NaN], { threshold: 0, limit: 5 })).rejects.toThrow();
        await expect(
          t.vector.searchByVector(Array(VECTOR_DIM + 1).fill(0.1), { threshold: 0, limit: 5 }),
        ).rejects.toThrow();
      });
    });

    it('accepts an all-zero vector without throwing', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await seedDoc(t.store, tx, [{ content: 'any', embedding: makeEmb(1, 1) }]);
        const res = await t.vector.searchByVector(dims(), { threshold: -1, limit: 5 });
        expect(Array.isArray(res)).toBe(true);
      });
    });
  });
}

function lexicalSuite(target: (client: Client) => Target): void {
  describe('lexical search', () => {
    it('matches token stems and excludes parent chunks', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await seedDoc(t.store, tx, [
          { content: 'running fast', kind: 'parent', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'running fast', chunkIndex: 1, kind: 'child', parentChunkId: 0, embedding: makeEmb(1, 1) },
          { content: 'standing still', chunkIndex: 2, embedding: makeEmb(1, 1) },
        ]);
        const res = await t.lexical.searchByLexical('run', { limit: 10 });
        expect(res.map((r) => r.content)).toEqual(['running fast']);
      });
    });

    it('orders by ts_rank descending', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await seedDoc(t.store, tx, [
          { content: 'run', embedding: makeEmb(1, 1) },
          { content: 'run run run run', embedding: makeEmb(1, 1) },
        ]);
        const res = await t.lexical.searchByLexical('run', { limit: 10 });
        expect(res[0]!.content).toBe('run run run run');
        expect(res[0]!.similarity).toBeGreaterThan(res[1]!.similarity);
      });
    });

    it('returns empty for a blank query and honors limit', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        await seedDoc(t.store, tx, [
          { content: 'alpha one', embedding: makeEmb(1, 1) },
          { content: 'alpha two', embedding: makeEmb(1, 1) },
          { content: 'beta three', embedding: makeEmb(1, 1) },
        ]);
        expect(await t.lexical.searchByLexical('   ', { limit: 10 })).toEqual([]);
        const limited = await t.lexical.searchByLexical('alpha', { limit: 2 });
        expect(limited).toHaveLength(2);
        expect(limited.every((r) => r.content.startsWith('alpha'))).toBe(true);
      });
    });

    it('honors the documentId filter and excludes soft-deleted documents', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docA = await seedDoc(t.store, tx, [{ content: 'needle', embedding: makeEmb(1, 1) }]);
        await seedDoc(t.store, tx, [{ content: 'needle', embedding: makeEmb(1, 1) }]);
        const filtered = await t.lexical.searchByLexical('needle', { limit: 10, filter: { documentId: docA } });
        expect(filtered.map((r) => r.content)).toEqual(['needle']);
        await softDeleteDocument(docA, new Date(), tx);
        const afterDelete = await t.lexical.searchByLexical('needle', { limit: 10 });
        expect(afterDelete.map((r) => r.content)).toEqual(['needle']);
        expect(afterDelete[0]!.documentId).not.toBe(docA);
      });
    });
  });
}

function storeSuite(target: (client: Client) => Target): void {
  describe('chunk store', () => {
    it('resolves parent/child self-FKs to real chunk ids', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [
          { content: 'parent block', kind: 'parent', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'child a', chunkIndex: 1, kind: 'child', parentChunkId: 0, embedding: makeEmb(1, 1) },
          { content: 'child b', chunkIndex: 2, kind: 'child', parentChunkId: 0, embedding: makeEmb(1, 1) },
        ]);
        const all = await t.store.getByDocAndRange(docId, 0, 2);
        const parent = all.find((r) => r.content === 'parent block')!;
        const childA = all.find((r) => r.content === 'child a')!;
        expect(childA.parentChunkId).toBe(parent.id);
        expect(childA.parentChunkId).not.toBe(0);
      });
    });

    it('rejects a child whose parent is missing from the batch', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, []);
        await expect(
          t.store.insertMany([
            {
              documentId: docId,
              content: 'orphan',
              embedding: makeEmb(1, 1),
              chunkIndex: 0,
              kind: 'child',
              parentChunkId: 42,
            },
          ]),
        ).rejects.toThrow(ValidationError);
      });
    });

    it('rejects duplicate parent chunkIndex values within a batch', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, []);
        await expect(
          t.store.insertMany([
            { documentId: docId, content: 'p1', embedding: makeEmb(1, 1), chunkIndex: 0, kind: 'parent' },
            { documentId: docId, content: 'p2', embedding: makeEmb(1, 1), chunkIndex: 0, kind: 'parent' },
          ]),
        ).rejects.toThrow('must be unique');
      });
    });

    it('getByIds returns rows ordered by id with zero similarity', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [
          { content: 'one', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'two', chunkIndex: 1, embedding: makeEmb(1, 1) },
          { content: 'three', chunkIndex: 2, embedding: makeEmb(1, 1) },
        ]);
        const all = await t.store.getByDocAndRange(docId, 0, 2);
        const ids = all.map((r) => r.id);
        expect(ids).toHaveLength(3);
        const res = await t.store.getByIds([...ids].reverse());
        expect(res.map((r) => r.id)).toEqual(ids);
        expect(res.map((r) => r.content)).toEqual(['one', 'two', 'three']);
        expect(res.every((r) => r.similarity === 0)).toBe(true);
      });
    });

    it('getByDocAndRange returns the inclusive [start, end] window ordered by chunkIndex', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [
          { content: 'w0', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'w1', chunkIndex: 1, embedding: makeEmb(1, 1) },
          { content: 'w2', chunkIndex: 2, embedding: makeEmb(1, 1) },
          { content: 'w3', chunkIndex: 3, embedding: makeEmb(1, 1) },
          { content: 'w4', chunkIndex: 4, embedding: makeEmb(1, 1) },
        ]);
        const res = await t.store.getByDocAndRange(docId, 1, 3);
        expect(res.map((r) => r.content)).toEqual(['w1', 'w2', 'w3']);
      });
    });

    it('getByDocAndRanges keys by documentId:start:end with overlap duplication', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docId = await seedDoc(t.store, tx, [
          { content: 'r0', chunkIndex: 0, embedding: makeEmb(1, 1) },
          { content: 'r1', chunkIndex: 1, embedding: makeEmb(1, 1) },
          { content: 'r2', chunkIndex: 2, embedding: makeEmb(1, 1) },
          { content: 'r3', chunkIndex: 3, embedding: makeEmb(1, 1) },
          { content: 'r4', chunkIndex: 4, embedding: makeEmb(1, 1) },
        ]);
        const map = await t.store.getByDocAndRanges([
          { documentId: docId, start: 0, end: 2 },
          { documentId: docId, start: 2, end: 4 },
        ]);
        expect(map.get(`${docId}:0:2`)!.map((r) => r.content)).toEqual(['r0', 'r1', 'r2']);
        expect(map.get(`${docId}:2:4`)!.map((r) => r.content)).toEqual(['r2', 'r3', 'r4']);
      });
    });

    it('deleteByDocumentId removes only that document\'s chunks', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const docA = await seedDoc(t.store, tx, [
          { content: 'a0', embedding: makeEmb(1, 1) },
          { content: 'a1', embedding: makeEmb(1, 1) },
        ]);
        const docB = await seedDoc(t.store, tx, [
          { content: 'b0', embedding: makeEmb(1, 1) },
          { content: 'b1', embedding: makeEmb(1, 1) },
          { content: 'b2', embedding: makeEmb(1, 1) },
        ]);
        await t.store.deleteByDocumentId(docA);
        expect(await t.store.countForDocument(docA)).toBe(0);
        expect(await t.store.countForDocument(docB)).toBe(3);
        const byDocs = await t.store.countForDocuments([docA, docB]);
        expect(byDocs.get(docB)).toBe(3);
        expect(byDocs.get(docA) ?? 0).toBe(0);
      });
    });

    it('countForAll, countForDocument and recountAll stay consistent', async () => {
      await rolledBack(async (tx) => {
        const t = target(tx);
        const before = await t.store.countForAll();
        const docA = await seedDoc(t.store, tx, [
          { content: 'a0', embedding: makeEmb(1, 1) },
          { content: 'a1', embedding: makeEmb(1, 1) },
        ]);
        const docB = await seedDoc(t.store, tx, [
          { content: 'b0', embedding: makeEmb(1, 1) },
          { content: 'b1', embedding: makeEmb(1, 1) },
          { content: 'b2', embedding: makeEmb(1, 1) },
        ]);
        expect(await t.store.countForAll()).toBe(before + 5);
        expect(await t.store.countForDocument(docA)).toBe(2);
        const recount = await t.store.recountAll();
        expect(recount.find((r) => r.documentId === docA)!.count).toBe(2);
        expect(recount.find((r) => r.documentId === docB)!.count).toBe(3);
      });
    });
  });
}

function transactionSuite(makeStore: (client: Client) => ChunkStore): void {
  describe('transactions', () => {
    it('commits inserts and deletes across db.transaction boundaries', async () => {
      const fileName = `contract-${randomUUID()}.pdf`;
      const fileHash = randomUUID();
      let docId = 0;
      await db.transaction(async (tx) => {
        const doc = await insertDocument({ fileName, fileHash, uploadedBy: 'contract-test' }, tx);
        docId = doc.id;
        await makeStore(tx).insertMany([
          { documentId: docId, content: 't0', embedding: makeEmb(1, 1) },
          { documentId: docId, content: 't1', embedding: makeEmb(1, 1) },
        ]);
      });
      expect(await makeStore(db).countForDocument(docId)).toBe(2);
      await db.transaction(async (tx) => {
        await makeStore(tx).deleteByDocumentId(docId);
        await deleteDocumentById(docId, tx);
      });
      expect(await makeStore(db).countForDocument(docId)).toBe(0);
    });

    it('rollback leaves no orphan chunks', async () => {
      let docId = 0;
      try {
        await db.transaction(async (tx) => {
          const doc = await insertDocument(
            { fileName: `contract-${randomUUID()}.pdf`, fileHash: randomUUID(), uploadedBy: 'contract-test' },
            tx,
          );
          docId = doc.id;
          await makeStore(tx).insertMany([
            { documentId: docId, content: 'r0', embedding: makeEmb(1, 1) },
            { documentId: docId, content: 'r1', embedding: makeEmb(1, 1) },
          ]);
          expect(await makeStore(tx).countForDocument(docId)).toBe(2);
          throw new Error('__CONTRACT_ROLLBACK__');
        });
      } catch (e) {
        if (e instanceof Error && e.message !== '__CONTRACT_ROLLBACK__') throw e;
      }
      expect(await makeStore(db).countForDocument(docId)).toBe(0);
    });
  });
}

export function runChunkContractTests(factories: ChunkContractFactories): void {
  describe('split ports', () => {
    const target = (client: Client): Target => ({
      vector: factories.makeVector(client),
      lexical: factories.makeLexical(client),
      store: factories.makeStore(client),
    });
    vectorSuite(target);
    lexicalSuite(target);
    storeSuite(target);
    transactionSuite(factories.makeStore);
  });

  describe('composite shim', () => {
    const target = (client: Client): Target => {
      const composite = factories.makeComposite(client);
      return { vector: composite, lexical: composite, store: composite };
    };
    vectorSuite(target);
    lexicalSuite(target);
    storeSuite(target);
    transactionSuite(factories.makeComposite);
  });
}