import path from 'node:path';
import os from 'node:os';
import type { RankedDocument, Reranker } from '@app/domain';

/**
 * Local cross-encoder reranker (Session 6).
 *
 * Runs a small cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2` by default,
 * overridable via `LOCAL_RERANK_MODEL`) entirely on-device via
 * `@xenova/transformers`, so reranking works with no API key. Unlike a
 * bi-encoder, the model sees the query and each document jointly and emits a
 * single relevance logit per pair, which we return as `relevanceScore`.
 *
 * The library and model are loaded lazily on first use and cached for the
 * process lifetime — nothing is imported (or downloaded) until `rank` is
 * actually called. `@xenova/transformers` is an optional dependency; if it is
 * unavailable the adapter throws, and `searchChunks` falls back to cosine
 * ordering.
 *
 * The model weights download from the HuggingFace hub on first load and are
 * cached under `TRANSFORMERS_CACHE` (defaulting to a temp dir). On read-only
 * filesystems (Docker/serverless root) point `TRANSFORMERS_CACHE` at a
 * writable location (e.g. `/tmp/xenova-cache`) so the download does not fail.
 */

type CrossEncoder = {
  tokenizer: (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>;
};

let encoderPromise: Promise<CrossEncoder> | null = null;

async function getEncoder(): Promise<CrossEncoder> {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      // Point the transformers cache at a writable dir before anything loads.
      // The default project FS is read-only on Docker/serverless except /tmp,
      // so a fixed cache path avoids download failures there. The package is
      // optional; if it cannot be imported the failure surfaces to the caller
      // (cosine fallback).
      const transformers = await import('@xenova/transformers');
      transformers.env.cacheDir =
        process.env.TRANSFORMERS_CACHE || path.join(os.tmpdir(), 'xenova-cache');
      const modelId = process.env.LOCAL_RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
      const { AutoTokenizer, AutoModelForSequenceClassification } = transformers;
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId),
        AutoModelForSequenceClassification.from_pretrained(modelId),
      ]);
      return {
        tokenizer: (
          text: string[],
          opts: { text_pair: string[]; padding: boolean; truncation: boolean },
        ) => tokenizer(text, opts) as Promise<Record<string, unknown>>,
        model: (inputs: Record<string, unknown>) =>
          model(inputs) as Promise<{ logits: { data: ArrayLike<number> } }>,
      };
    })().catch((cause) => {
      // Reset so a later call can retry (e.g. after a transient download failure).
      encoderPromise = null;
      throw cause;
    });
  }
  return encoderPromise;
}

export const localReranker: Reranker = {
  async rank(query: string, documents: string[]): Promise<RankedDocument[]> {
    if (documents.length === 0) return [];

    const { tokenizer, model } = await getEncoder();
    const queries = documents.map(() => query);
    const inputs = await tokenizer(queries, {
      text_pair: documents,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const scores = Array.from(logits.data as ArrayLike<number>);

    return documents.map((_, index) => ({
      index,
      relevanceScore: scores[index] ?? 0,
    }));
  },
};
