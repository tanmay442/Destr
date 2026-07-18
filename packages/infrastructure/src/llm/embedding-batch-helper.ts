import { embedMany } from 'ai';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_CONCURRENCY } from '@app/domain';

type ProviderOptions = NonNullable<Parameters<typeof embedMany>[0]['providerOptions']>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function embedManyWithRetry(
  batch: string[],
  model: EmbeddingModelV3,
  providerOptions?: ProviderOptions,
): Promise<number[][]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { embeddings } = await embedMany({
        model,
        values: batch,
        ...(providerOptions ? { providerOptions } : {}),
      });
      return embeddings;
    } catch (err) {
      if (attempt === 0) {
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable retry loop');
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
        embedManyWithRetry(batch, model, providerOptions).then((embs) => ({
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
