import path from 'node:path';
import os from 'node:os';
import type { RankedDocument, Reranker, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { registerRerankerProvider } from './registries';
import { createRetryBudget } from './retry';

const LOCAL_RERANK_TIMEOUT_MS = 10_000;

type CrossEncoder = {
  tokenizer: (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Record<string, unknown> | PromiseLike<Record<string, unknown>>;
  model: (
    inputs: Record<string, unknown>,
  ) => { logits: { data: ArrayLike<number> } } | PromiseLike<{ logits: { data: ArrayLike<number> } }>;
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** True when the optional `@xenova/transformers` package can be imported. */
export async function checkLocalRerankerAvailable(): Promise<boolean> {
  try {
    await import('@xenova/transformers');
    return true;
  } catch {
    return false;
  }
}

let encoderPromise: Promise<CrossEncoder> | null = null;
let encoderKey: string | null = null;

async function getEncoder(cacheDir: string, modelId: string): Promise<CrossEncoder> {
  const key = `${cacheDir}|${modelId}`;
  if (!encoderPromise || encoderKey !== key) {
    encoderKey = key;
    encoderPromise = (async () => {
      const transformers = await import('@xenova/transformers');
      transformers.env.cacheDir = cacheDir;
      const { AutoTokenizer, AutoModelForSequenceClassification } = transformers;
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(modelId),
        AutoModelForSequenceClassification.from_pretrained(modelId),
      ]);
      return {
        tokenizer: (
          text: string[],
          opts: { text_pair: string[]; padding: boolean; truncation: boolean },
        ) => tokenizer(text, opts) as Record<string, unknown> | PromiseLike<Record<string, unknown>>,
        model: (inputs: Record<string, unknown>) =>
          model(inputs) as { logits: { data: ArrayLike<number> } }
            | PromiseLike<{ logits: { data: ArrayLike<number> } }>,
      };
    })().catch((cause) => {
      encoderPromise = null;
      encoderKey = null;
      throw cause;
    });
  }
  return encoderPromise;
}

function abortableLocal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

export function createLocalReranker(env: EnvSource = defaultProcessEnv): Reranker {
  return {
    async rank(
      query: string,
      documents: string[],
      opts?: { signal?: AbortSignal },
    ): Promise<RankedDocument[]> {
      if (documents.length === 0) return [];

      const cacheDir = env.get('TRANSFORMERS_CACHE') || path.join(os.tmpdir(), 'xenova-cache');
      const modelId = env.get('LOCAL_RERANK_MODEL') || 'Xenova/ms-marco-MiniLM-L-6-v2';
      const budget = createRetryBudget(LOCAL_RERANK_TIMEOUT_MS, opts?.signal);
      try {
        // Xenova inference cannot be preempted after native work starts. The
        // caller still receives cancellation/timeout promptly; late work is
        // observed by abortableLocal so it cannot become an unhandled reject.
        const { tokenizer, model } = await abortableLocal(getEncoder(cacheDir, modelId), budget.signal);
        const queries = documents.map(() => query);
        const inputs = await abortableLocal(Promise.resolve(tokenizer(queries, {
          text_pair: documents,
          padding: true,
          truncation: true,
        })), budget.signal);
        const { logits } = await abortableLocal(Promise.resolve(model(inputs)), budget.signal);
        const scores = Array.from(logits.data);

        return documents.map((_, index) => ({
          index,
          relevanceScore: sigmoid(scores[index] ?? 0),
        }));
      } finally {
        budget.dispose();
      }
    },
  };
}

export const localReranker: Reranker = createLocalReranker();

registerRerankerProvider('local', (deps) => createLocalReranker(deps.env));
