import { describe, it, expect, vi } from 'vitest';
import { ValidationError } from '@app/domain';
import { insertChunks } from '../repositories';

type Client = Parameters<typeof insertChunks>[1];

type TestRow = {
  documentId: number;
  content: string;
  embedding: number[];
  chunkIndex?: number;
  page?: number | null;
  sectionTitle?: string | null;
  source?: string | null;
  parentChunkId?: number | null;
  kind?: 'parent' | 'child' | 'summary';
  embeddingModel?: string | null;
  contentHash?: string | null;
};

type ReturnedId = { id: number; chunkIndex: number };

function makeFakeClient() {
  const calls: Array<{ rows: TestRow[]; isParent: boolean }> = [];
  const parentIds: number[] = [];
  const builder = {
    values: vi.fn((rows: TestRow | TestRow[]) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const isParent = arr.length > 0 && arr[0]?.kind === 'parent';
      const result = Promise.resolve(undefined) as Promise<void> & {
        returning: () => Promise<ReturnedId[]>;
      };
      result.returning = async () =>
        arr.map((r) => {
          const id = 1000 + parentIds.length;
          parentIds.push(id);
          return { id, chunkIndex: r.chunkIndex ?? 0 };
        });
      calls.push({ rows: arr, isParent });
      return result;
    }),
  };
  const insert = vi.fn(() => builder);
  return { insert, calls, parentIds };
}

const DIM = 768;
const emb = () => Array.from({ length: DIM }, () => 0.1);

describe('insertChunks two-pass (parent-child)', () => {
  it('inserts parents before children and rewrites child parentChunkId to the real id', async () => {
    const client = makeFakeClient();
    const rows: TestRow[] = [
      { documentId: 1, content: 'PARENT BLOCK', embedding: emb(), chunkIndex: 0, kind: 'parent', parentChunkId: null },
      { documentId: 1, content: 'child a', embedding: emb(), chunkIndex: 1, kind: 'child', parentChunkId: 0 },
      { documentId: 1, content: 'child b', embedding: emb(), chunkIndex: 2, kind: 'child', parentChunkId: 0 },
    ];
    await insertChunks(rows, client as unknown as Client);

    expect(client.calls.length).toBe(2);
    expect(client.calls[0]!.isParent).toBe(true);
    expect(client.calls[1]!.isParent).toBe(false);

    const childRows = client.calls[1]!.rows;
    expect(childRows).toHaveLength(2);
    expect(childRows.every((r) => r.parentChunkId === 1000)).toBe(true);

    expect(client.calls[0]!.rows.every((r) => r.parentChunkId === null)).toBe(true);
  });

  it('single-pass when there are no parent chunks', async () => {
    const client = makeFakeClient();
    const rows: TestRow[] = [
      { documentId: 1, content: 'flat', embedding: emb(), chunkIndex: 0, kind: 'child' },
    ];
    await insertChunks(rows, client as unknown as Client);
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.isParent).toBe(false);
  });

  it('rejects embeddings with the wrong dimension', async () => {
    const client = makeFakeClient();
    const err = await insertChunks(
      [{ documentId: 1, content: 'x', embedding: [0.1], chunkIndex: 0, kind: 'child' }],
      client as unknown as Client,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/expected 768/);
  });

  it('rejects non-finite embedding values with a descriptive ValidationError', async () => {
    const client = makeFakeClient();
    const err = await insertChunks(
      [{ documentId: 1, content: 'x', embedding: [Number.NaN, ...Array(DIM - 1).fill(0.1)], chunkIndex: 3, kind: 'child' }],
      client as unknown as Client,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/chunk 3 contains non-finite values/);
  });

  it('rejects a child-only batch that references a parent not in the batch', async () => {
    const client = makeFakeClient();
    const err = await insertChunks(
      [{ documentId: 1, content: 'a', embedding: emb(), chunkIndex: 0, kind: 'child', parentChunkId: 77 }],
      client as unknown as Client,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/Parent chunk 77 not found in batch/);
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a two-pass batch whose child points at a parent index that never materialized', async () => {
    const client = makeFakeClient();
    const rows: TestRow[] = [
      { documentId: 1, content: 'P', embedding: emb(), chunkIndex: 0, kind: 'parent', parentChunkId: null },
      { documentId: 1, content: 'c', embedding: emb(), chunkIndex: 1, kind: 'child', parentChunkId: 9 },
    ];
    const err = await insertChunks(rows, client as unknown as Client).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/Parent chunk 9 not found in batch for chunk 1/);
  });
});
