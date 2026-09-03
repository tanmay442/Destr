import type { RankedDocument, Reranker, EnvSource } from '@app/domain';
import { defaultProcessEnv } from '../config/env';
import { retryOnTransient } from './retry';
import { registerRerankerProvider } from './registries';

const COHERE_RERANK_URL = 'https://api.cohere.ai/v1/rerank';
const COHERE_RETRY_ATTEMPTS = 3;
const COHERE_TIMEOUT_MS = 10_000;

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results?: CohereRerankResult[];
}

export function createCohereReranker(env: EnvSource = defaultProcessEnv): Reranker {
  return {
    async rank(query: string, documents: string[]): Promise<RankedDocument[]> {
      if (documents.length === 0) return [];

      const apiKey = env.get('COHERE_API_KEY');
      if (!apiKey) {
        throw new Error('COHERE_API_KEY must be set to use the Cohere reranker.');
      }
      const model = env.get('COHERE_RERANK_MODEL') || 'rerank-english-v3.0';

      return retryOnTransient(
        async () => {
          const res = await fetch(COHERE_RERANK_URL, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify({ model, query, documents, top_n: documents.length }),
            signal: AbortSignal.timeout(COHERE_TIMEOUT_MS),
          });

          if (!res.ok) {
            const body = (await res.text().catch(() => ''))
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 200);
            throw Object.assign(new Error(`Cohere rerank failed (${res.status}): ${body}`), {
              statusCode: res.status,
            });
          }

          const json = (await res.json()) as CohereRerankResponse;
          const results = json.results ?? [];
          return results.map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
        },
        'Cohere rerank',
        COHERE_RETRY_ATTEMPTS,
      );
    },
  };
}

export const cohereReranker: Reranker = createCohereReranker();

registerRerankerProvider('cohere', (deps) => (deps.env.get('COHERE_API_KEY') ? createCohereReranker(deps.env) : undefined));
