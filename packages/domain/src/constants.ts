/** Parse a numeric env string, falling back when not finite (rejects NaN). */
export function finiteOrDefault(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
export const CHAT_MAX_BODY_BYTES = 1_000_000;
export const BLOB_GET_MAX_BYTES = finiteOrDefault(process.env.BLOB_GET_MAX_BYTES, 50_000_000);
export const UPLOAD_CHUNKED_MAX_MD_BYTES = finiteOrDefault(process.env.UPLOAD_CHUNKED_MAX_MD_BYTES, 25_000_000);
export const UPLOAD_CHUNKED_MAX_PDF_BYTES = finiteOrDefault(process.env.UPLOAD_CHUNKED_MAX_PDF_BYTES, 100_000_000);
export const PDF_PARSE_MAX_BYTES = finiteOrDefault(process.env.PDF_PARSE_MAX_BYTES, 100_000_000);
export const PDF_PARSE_MAX_PAGES = finiteOrDefault(process.env.PDF_PARSE_MAX_PAGES, 5000);
export const PDF_PARSE_MAX_CHARS = finiteOrDefault(process.env.PDF_PARSE_MAX_CHARS, 50_000_000);
export const CCH_ENABLED = process.env.CCH_ENABLED !== 'false';
export const CCH_MODEL = process.env.CCH_MODEL ?? '';
export const CCH_CONTEXT_CHARS = 4000;
export const CITATION_SNIPPET_MAX = 150;
export const DEFAULT_SEARCH_LIMIT = 3;
export const MD_CHUNK_DELIMITER = process.env.MD_CHUNK_DELIMITER ?? '---chunk---';
export const EMBEDDING_BATCH_CONCURRENCY = 3;
export const EMBEDDING_BATCH_SIZE = 50;
export const MAX_AUDIT_LIMIT = 200;
export const MAX_LIST_LIMIT = 100;
export const MAX_TICKET_NOTES_LENGTH = 10_000;
export const INGEST_CHUNK_SIZE = finiteOrDefault(process.env.INGEST_CHUNK_SIZE, 800);
export const INGEST_CHUNK_OVERLAP = Math.floor(INGEST_CHUNK_SIZE / 10);
export const PARENT_CHUNK_SIZE = finiteOrDefault(process.env.PARENT_CHUNK_SIZE, 1800);
export const CHILD_CHUNK_SIZE = finiteOrDefault(process.env.CHILD_CHUNK_SIZE, 400);
export const PARENT_CHILD_MODE = (process.env.PARENT_CHILD_MODE ?? 'parent') as 'parent' | 'window';
export const PARENT_CHILD_WINDOW = finiteOrDefault(process.env.PARENT_CHILD_WINDOW, 2);
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Reranker providers: 'cosine' (default, zero deps), 'local' (Xenova cross-encoder), 'cohere' (hosted). Falls back to cosine on failure. */
export const RERANKER_PROVIDER = (process.env.RERANKER_PROVIDER ?? 'cosine') as 'cosine' | 'local' | 'cohere';
export const CANDIDATE_POOL = finiteOrDefault(process.env.CANDIDATE_POOL, 30);
export const RERANK_TOP_N = finiteOrDefault(process.env.RERANK_TOP_N, DEFAULT_SEARCH_LIMIT);

/** Fuse vector + BM25 lexical via Reciprocal Rank Fusion. */
export const HYBRID_ENABLED = process.env.HYBRID_ENABLED !== 'false';
export const RRF_K = finiteOrDefault(process.env.RRF_K, 60);
export const LEXICAL_WEIGHT = finiteOrDefault(process.env.LEXICAL_WEIGHT, 1);
export const SIMILARITY_THRESHOLD = 0.5;
export const TOOL_CONTENT_CAP = 800;
export const AGENTIC_ENABLED = process.env.AGENTIC_ENABLED !== 'false';
export const GRADE_MODEL = process.env.GRADE_MODEL ?? '';
export const OUT_OF_DOMAIN_THRESHOLD = finiteOrDefault(process.env.OUT_OF_DOMAIN_THRESHOLD, 0.3);
export const AGENT_STEP_BUDGET = finiteOrDefault(process.env.AGENT_STEP_BUDGET, 8);
/** Broad candidate pool for agentic re-retrieval (step-back / sub-query). */
export const AGENTIC_RETRIEVE_LIMIT = finiteOrDefault(process.env.AGENTIC_RETRIEVE_LIMIT, 10);
/** Max rewrite+retry passes before falling back to the ticket offer. */
export const AGENTIC_MAX_RETRIES = finiteOrDefault(process.env.AGENTIC_MAX_RETRIES, 1);
/** Answer cache TTL in seconds. Keyed on normalised query + model ids. */
export const ANSWER_CACHE_ENABLED = process.env.ANSWER_CACHE_ENABLED !== 'false';
export const ANSWER_CACHE_TTL_SEC = finiteOrDefault(process.env.ANSWER_CACHE_TTL_SEC, 3600);
/** Emit structured logger spans around retrieval + agentic steps. Off by default. */
export const TRACE_ENABLED = process.env.TRACE_ENABLED === 'true';
/** CI gate — fail when mean faithfulness/relevancy drops below this. */
export const EVAL_FAITHFULNESS_THRESHOLD = finiteOrDefault(process.env.EVAL_FAITHFULNESS_THRESHOLD, 0.7);
