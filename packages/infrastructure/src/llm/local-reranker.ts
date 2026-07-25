import path from 'node:path';
import os from 'node:os';
import type { RankedDocument, Reranker } from '@app/domain';

/**
 * Local cross-encoder reranker — runs on-device via `@xenova/transformers`
 * (no API key needed). Model is `Xenova/ms-marco-MiniLM-L-6-v2` by default,
 * overridable via `LOCAL_RERANK_MODEL`. Weights download on first use from
 * HuggingFace and are cached under `TRANSFORMERS_CACHE` (writable dir
 * required on read-only filesystems).
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
      // Point cache at a writable dir (default FS is read-only except /tmp).
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
