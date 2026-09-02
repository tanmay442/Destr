import { embedMany } from 'ai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_CONCURRENCY } from '@app/domain';
import {
  EMBEDDING_RETRY_BUDGET_MS,
  EMBED_REQUEST_TIMEOUT_MS,
  assertRetryBudget,
  createRetryBudget,
  isRetryBudgetExceeded,
  retryOnTransient,
  type RetryBudget,
} from './retry';

const EMBED_RETRY_ATTEMPTS = 3;

type ProviderOptions = NonNullable<Parameters<typeof embedMany>[0]['providerOptions']>;

export interface EmbeddingBatchOptions {
  budget?: RetryBudget;
  maxDurationMs?: number;
  signal?: AbortSignal;
}

async function embedManyWithRetry(
  batch: string[],
  model: EmbeddingModelV3,
  offset: number,
  providerOptions: ProviderOptions | undefined,
  budget: RetryBudget,
): Promise<number[][]> {
  try {
    return await retryOnTransient(
      async () => {
        assertRetryBudget(budget, `Embedding request at offset ${offset}`);
        const remainingMs = budget.remainingMs();
        const requestSignal = AbortSignal.any([
          budget.signal,
          AbortSignal.timeout(Math.max(1, Math.min(EMBED_REQUEST_TIMEOUT_MS, remainingMs))),
        ]);
        const { embeddings } = await embedMany({
          model,
          values: batch,
          maxRetries: 0,
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: requestSignal,
        });
        return embeddings;
      },
      `Embedding request at offset ${offset}`,
      EMBED_RETRY_ATTEMPTS,
      { budget },
    );
  } catch (err) {
    if (isRetryBudgetExceeded(err)) throw err;
    throw new Error(
      `Embedding request failed at offset ${offset} after ${EMBED_RETRY_ATTEMPTS} attempts`,
      { cause: err },
    );
  }
}

export async function embedBatchWithModel(
  values: string[],
  model: EmbeddingModelV3,
  providerOptions?: ProviderOptions,
  options: EmbeddingBatchOptions = {},
): Promise<number[][]> {
  if (values.length === 0) return [];

  const ownsBudget = options.budget === undefined;
  const budget = options.budget ?? createRetryBudget(options.maxDurationMs ?? EMBEDDING_RETRY_BUDGET_MS, options.signal);
  try {
    const batches: string[][] = [];
    for (let i = 0; i < values.length; i += EMBEDDING_BATCH_SIZE) {
      batches.push(values.slice(i, i + EMBEDDING_BATCH_SIZE));
    }

    const out: number[][] = [];
    for (let i = 0; i < batches.length; i += EMBEDDING_BATCH_CONCURRENCY) {
      assertRetryBudget(budget, 'Embedding batch');
      const chunk = batches.slice(i, i + EMBEDDING_BATCH_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((batch, idx) =>
          embedManyWithRetry(batch, model, (i + idx) * EMBEDDING_BATCH_SIZE, providerOptions, budget).then((embs) => ({
            embs,
            expected: batch.length,
            offset: (i + idx) * EMBEDDING_BATCH_SIZE,
          })),
        ),
      );
      for (const result of results) {
        if (result.embs.length !== result.expected) {
          throw new Error(
            `Embedding failed for batch at offset ${result.offset}: expected ${result.expected}, got ${result.embs.length}`,
          );
        }
        out.push(...result.embs);
      }
    }
    assertRetryBudget(budget, 'Embedding batch');
    return out;
  } finally {
    if (ownsBudget) budget.dispose();
  }
}
