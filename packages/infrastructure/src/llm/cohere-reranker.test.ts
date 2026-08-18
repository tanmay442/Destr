import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cohereReranker } from './cohere-reranker';

vi.mock('./retry', async () => {
  const actual = await vi.importActual<typeof import('./retry')>('./retry');
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

const fetchMock = vi.fn();

describe('cohereReranker', () => {
  const originalKey = process.env.COHERE_API_KEY;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.COHERE_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.COHERE_API_KEY;
    else process.env.COHERE_API_KEY = originalKey;
  });

  it('returns empty for empty input without calling the API', async () => {
    expect(await cohereReranker.rank('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns one ranked result per document preserving the original index', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.92 },
          { index: 0, relevance_score: 0.31 },
        ],
      }),
    });

    const ranked = await cohereReranker.rank('query', ['first', 'second']);

    expect(ranked).toEqual([
      { index: 1, relevanceScore: 0.92 },
      { index: 0, relevanceScore: 0.31 },
    ]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/v1/rerank');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'rerank-english-v3.0',
      query: 'query',
      documents: ['first', 'second'],
      top_n: 2,
    });
  });

  it('throws when COHERE_API_KEY is missing', async () => {
    delete process.env.COHERE_API_KEY;
    await expect(cohereReranker.rank('q', ['doc'])).rejects.toThrow('COHERE_API_KEY');
  });

  it('retries retryable 5xx responses before succeeding', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ index: 0, relevance_score: 0.8 }] }),
      });

    const ranked = await cohereReranker.rank('q', ['doc']);
    expect(ranked).toEqual([{ index: 0, relevanceScore: 0.8 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws non-retryable errors immediately', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
    await expect(cohereReranker.rank('q', ['doc'])).rejects.toThrow('Cohere rerank failed (400)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('truncates and sanitizes the API error body before propagating it', async () => {
    const leaked = 'SECRET-CHUNK-CONTENT '.repeat(100);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => `\u0000${leaked}\n\u001f${leaked}`,
    });

    const err = (await cohereReranker.rank('q', ['doc']).catch((e) => e)) as Error;
    expect((err as { statusCode?: number }).statusCode).toBe(400);
    expect(err.message).toMatch(/^Cohere rerank failed \(400\): SECRET-CHUNK-CONTENT/);
    expect(err.message.length).toBeLessThan(250);
    expect(err.message).not.toContain(leaked);
    expect(err.message).not.toContain('\u0000');
    expect(err.message).not.toContain('\u001f');
  });
});
