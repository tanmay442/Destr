import { embedMany } from 'ai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_CONCURRENCY } from '@app/domain';
import { isRetryableError, retryDelay, sleep } from './retry';

const EMBED_RETRY_ATTEMPTS = 5;

type ProviderOptions = NonNullable<Parameters<typeof embedMany>[0]['providerOptions']>;

async function embedManyWithRetry(
  batch: string[],
  model: EmbeddingModelV3,
  offset: number,
  providerOptions?: ProviderOptions,
): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < EMBED_RETRY_ATTEMPTS; attempt++) {
    try {
      const { embeddings } = await embedMany({
        model,
        values: batch,
        ...(providerOptions ? { providerOptions } : {}),
      });
      return embeddings;
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === EMBED_RETRY_ATTEMPTS - 1) break;
      await sleep(retryDelay(attempt));
    }
  }
  throw new Error(
    `Embedding request failed at offset ${offset} after ${EMBED_RETRY_ATTEMPTS} attempts`,
    { cause: lastErr },
  );
}

export async function embedBatchWithModel(
  values: string[],
  model: EmbeddingModelV3,
  providerOptions?: ProviderOptions,
): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < values.length; i += EMBEDDING_BATCH_SIZE) {
    batches.push(values.slice(i, i + EMBEDDING_BATCH_SIZE));
  }

  const out: number[][] = [];
  for (let i = 0; i < batches.length; i += EMBEDDING_BATCH_CONCURRENCY) {
    const chunk = batches.slice(i, i + EMBEDDING_BATCH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((batch, idx) =>
        embedManyWithRetry(batch, model, (i + idx) * EMBEDDING_BATCH_SIZE, providerOptions).then((embs) => ({
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
  return out;
}
