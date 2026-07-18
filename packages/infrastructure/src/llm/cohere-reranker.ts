import type { RankedDocument, Reranker } from '@app/domain';

/** Cohere Rerank API endpoint. */
const COHERE_RERANK_URL = 'https://api.cohere.ai/v1/rerank';

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

interface CohereRerankResponse {
  results?: CohereRerankResult[];
}

/**
 * Hosted reranker backed by Cohere's Rerank API (Session 6).
 *
 * Selected when `RERANKER_PROVIDER=cohere`. Requires `COHERE_API_KEY`; the
 * model is overridable via `COHERE_RERANK_MODEL` (default
 * `rerank-english-v3.0`). Returns one `RankedDocument` per input document,
 * carrying the original index and Cohere's `relevance_score` (0..1).
 */
export const cohereReranker: Reranker = {
  async rank(query: string, documents: string[]): Promise<RankedDocument[]> {
    if (documents.length === 0) return [];

    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error('COHERE_API_KEY must be set to use the Cohere reranker.');
    }
    const model = process.env.COHERE_RERANK_MODEL || 'rerank-english-v3.0';

    const res = await fetch(COHERE_RERANK_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ model, query, documents, top_n: documents.length }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cohere rerank failed (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as CohereRerankResponse;
    const results = json.results ?? [];
    return results.map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
  },
};
