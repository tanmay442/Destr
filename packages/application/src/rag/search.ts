import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { ChunkRepository, EmbeddingService } from '@app/domain';
import { SIMILARITY_THRESHOLD, DEFAULT_SEARCH_LIMIT } from '../../../../config/constants';
import { sanitizePagination } from '../service-result';

const MAX_SEARCH_LIMIT = 50;

export interface RetrievedChunk {
  content: string;
  similarity: number;
}

export interface SearchDeps {
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
}

export interface SearchOpts {
  threshold?: number;
  limit?: number;
}

export async function searchChunks(
  query: string,
  opts: SearchOpts,
  deps: SearchDeps,
): Promise<Result<RetrievedChunk[]>> {
  if (query.trim() === '') {
    return ok([]);
  }
  const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
  const { limit } = sanitizePagination(opts.limit, undefined, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  let embedding: number[];
  try {
    embedding = await deps.embeddings.embed(query);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  let rows: Awaited<ReturnType<ChunkRepository['searchByVector']>>;
  try {
    rows = await deps.chunks.searchByVector(embedding, { threshold, limit });
  } catch (cause) {
    return err(new ExternalServiceError('Vector search failed', cause));
  }
  return ok(
    rows.map((r) => ({ content: r.content, similarity: Number(r.similarity) })),
  );
}
