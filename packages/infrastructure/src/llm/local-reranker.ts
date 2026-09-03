import path from 'node:path';
import os from 'node:os';
import type { RankedDocument, Reranker, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { registerRerankerProvider } from './registries';

type CrossEncoder = {
  tokenizer: (
    text: string[],
    opts: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>;
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
        ) => tokenizer(text, opts) as Promise<Record<string, unknown>>,
        model: (inputs: Record<string, unknown>) =>
          model(inputs) as Promise<{ logits: { data: ArrayLike<number> } }>,
      };
    })().catch((cause) => {
      encoderPromise = null;
      encoderKey = null;
      throw cause;
    });
  }
  return encoderPromise;
}

export function createLocalReranker(env: EnvSource = defaultProcessEnv): Reranker {
  return {
    async rank(query: string, documents: string[]): Promise<RankedDocument[]> {
      if (documents.length === 0) return [];

      const cacheDir = env.get('TRANSFORMERS_CACHE') || path.join(os.tmpdir(), 'xenova-cache');
      const modelId = env.get('LOCAL_RERANK_MODEL') || 'Xenova/ms-marco-MiniLM-L-6-v2';
      const { tokenizer, model } = await getEncoder(cacheDir, modelId);
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
        relevanceScore: sigmoid(scores[index] ?? 0),
      }));
    },
  };
}

export const localReranker: Reranker = createLocalReranker();

registerRerankerProvider('local', (deps) => createLocalReranker(deps.env));
