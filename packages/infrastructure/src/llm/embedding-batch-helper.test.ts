import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBEDDING_BATCH_SIZE } from '@app/domain';
import { embedBatchWithModel } from './embedding-batch-helper';

const embedManyMock = vi.hoisted(() => vi.fn());

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, embedMany: (...args: unknown[]) => embedManyMock(...args) };
});
vi.mock('./retry', async () => {
  const actual = await vi.importActual<typeof import('./retry')>('./retry');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

const model = { modelId: 'mock-embed' } as never;

function embeddingsFor(values: string[]): number[][] {
  return values.map((v) => [v.length]);
}

describe('embedBatchWithModel', () => {
  beforeEach(() => {
    embedManyMock.mockReset();
  });

  it('embeds all values in batches of EMBEDDING_BATCH_SIZE', async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => ({
      embeddings: embeddingsFor(values),
    }));

    const total = EMBEDDING_BATCH_SIZE * 2 + 7;
    const values = Array.from({ length: total }, (_, i) => `v${i}`);
    const result = await embedBatchWithModel(values, model);

    expect(result).toHaveLength(total);
    expect(embedManyMock).toHaveBeenCalledTimes(3);
  });

  it('retries retryable 429 failures and succeeds on the retry', async () => {
    const retryable = Object.assign(new Error('rate limited'), { statusCode: 429 });
    embedManyMock
      .mockRejectedValueOnce(retryable)
      .mockImplementation(async ({ values }: { values: string[] }) => ({
        embeddings: embeddingsFor(values),
      }));

    const result = await embedBatchWithModel(['a', 'b'], model);
    expect(result).toHaveLength(2);
    expect(embedManyMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-retryable errors immediately with the failing batch offset', async () => {
    embedManyMock.mockRejectedValue(new Error('bad request'));

    await expect(embedBatchWithModel(['a'], model)).rejects.toThrow(
      'Embedding request failed at offset 0 after 5 attempts',
    );
    expect(embedManyMock).toHaveBeenCalledTimes(1);
  });

  it('throws a descriptive error when the model returns a count mismatch', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[1]] });

    await expect(embedBatchWithModel(['a', 'b'], model)).rejects.toThrow(
      'Embedding failed for batch at offset 0: expected 2, got 1',
    );
  });

  it('reports the correct offset for failures in later batches', async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => {
      if (values.length === 2) return { embeddings: [[1]] };
      return { embeddings: embeddingsFor(values) };
    });

    const values = Array.from({ length: EMBEDDING_BATCH_SIZE + 2 }, (_, i) => `v${i}`);
    await expect(embedBatchWithModel(values, model)).rejects.toThrow(
      `Embedding failed for batch at offset ${EMBEDDING_BATCH_SIZE}: expected 2, got 1`,
    );
  });
});
