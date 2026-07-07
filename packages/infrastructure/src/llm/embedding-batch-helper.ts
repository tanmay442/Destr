// Shared embedding batch processor. Splits a large list of values into
// configurable batches, runs them with bounded concurrency, and retries
// individual failures once. Used by all EmbeddingService adapters.
import { embed } from 'ai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_CONCURRENCY } from '../../../../config/constants';

type ProviderOptions = NonNullable<Parameters<typeof embed>[0]['providerOptions']>;

async function processBatch(
  batch: string[],
  batchOffset: number,
  model: EmbeddingModelV3,
  providerOptions?: ProviderOptions,
): Promise<number[][]> {
  const embedOne = (value: string) =>
    embed({ model, value, ...(providerOptions ? { providerOptions } : {}) }).then(
      ({ embedding }) => embedding,
    );

  const results = await Promise.allSettled(batch.map(embedOne));

  const embeddings: (number[] | null)[] = new Array(batch.length).fill(null);
  const failedIndices: number[] = [];

  for (let j = 0; j < results.length; j++) {
    const r = results[j];
    if (r.status === 'fulfilled') {
      embeddings[j] = r.value;
    } else {
      console.error(`Embedding failed for chunk ${batchOffset + j}:`, r.reason);
      failedIndices.push(j);
    }
  }

  if (failedIndices.length > 0) {
    console.warn(
      `Retrying ${failedIndices.length} failed embedding(s) from batch at offset ${batchOffset}`,
    );
    const retryResults = await Promise.allSettled(failedIndices.map((idx) => embedOne(batch[idx])));
    for (let j = 0; j < failedIndices.length; j++) {
      const rr = retryResults[j];
      if (rr.status === 'fulfilled') {
        embeddings[failedIndices[j]] = rr.value;
      } else {
        console.error(`Embedding retry failed for chunk ${failedIndices[j]}:`, rr.reason);
      }
    }
  }

  const filtered = embeddings.filter((e): e is number[] => e !== null);
  if (filtered.length !== batch.length) {
    throw new Error(
      `Embedding batch incomplete: ${filtered.length}/${batch.length} succeeded at offset ${batchOffset}`,
    );
  }
  return filtered;
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
        processBatch(batch, (i + idx) * EMBEDDING_BATCH_SIZE, model, providerOptions),
      ),
    );
    for (const result of results) {
      out.push(...result);
    }
  }
  return out;
}
