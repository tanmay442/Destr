import { describe, it, expect, vi } from 'vitest';
import { insertChunks } from '../repositories';
import type { Client } from '../client';

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

/**
 * Build a fake drizzle client. `insert(table).values(rows)` returns a thenable
 * object that also exposes `.returning()` (used by the parent pass). Parent
 * inserts are detected by `kind === 'parent'` and assigned surrogate ids
 * (1000, 1001, ...) so we can assert the child FK rewrite.
 */
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
      // Parent 0 -> chunkIndex 0
      { documentId: 1, content: 'PARENT BLOCK', embedding: emb(), chunkIndex: 0, kind: 'parent', parentChunkId: null },
      // Child referencing parent via transient key (parent's chunkIndex = 0)
      { documentId: 1, content: 'child a', embedding: emb(), chunkIndex: 1, kind: 'child', parentChunkId: 0 },
      { documentId: 1, content: 'child b', embedding: emb(), chunkIndex: 2, kind: 'child', parentChunkId: 0 },
    ];
    await insertChunks(rows, client as unknown as Client);

    // Parents are inserted first, children after.
    expect(client.calls.length).toBe(2);
    expect(client.calls[0]!.isParent).toBe(true);
    expect(client.calls[1]!.isParent).toBe(false);

    // Children carry the resolved real parent id (1000), not the transient key.
    const childRows = client.calls[1]!.rows;
    expect(childRows).toHaveLength(2);
    expect(childRows.every((r) => r.parentChunkId === 1000)).toBe(true);

    // Parents themselves have a null parentChunkId.
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
    await expect(
      insertChunks([{ documentId: 1, content: 'x', embedding: [0.1], chunkIndex: 0, kind: 'child' }], client as unknown as Client),
    ).rejects.toThrow(/expected 768/);
  });
});
