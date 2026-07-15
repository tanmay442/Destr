// Centralised business-logic constants. Keep sorted alphabetically.
// Tune these to change behaviour without hunting through source files.
//
// TODO: Add tests for rate limiter concurrency, ticket ID collision,
// embedding batch retry logic, and composition root wiring.

export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
export const CCH_ENABLED = process.env.CCH_ENABLED !== 'false'; // default on
export const CCH_MODEL = process.env.CCH_MODEL ?? ''; // optional cheap model override
export const CCH_CONTEXT_CHARS = 4000; // chars of doc text fed to the summarizer
export const CITATION_SNIPPET_MAX = 150;
export const DEFAULT_SEARCH_LIMIT = 3;
export const MD_CHUNK_DELIMITER = process.env.MD_CHUNK_DELIMITER ?? '---chunk---';
export const EMBEDDING_BATCH_CONCURRENCY = 3;
export const EMBEDDING_BATCH_SIZE = 50;
export const MAX_AUDIT_LIMIT = 200;
export const MAX_LIST_LIMIT = 100;
export const MAX_TICKET_NOTES_LENGTH = 10_000;
export const INGEST_CHUNK_SIZE = Number(process.env.INGEST_CHUNK_SIZE ?? 800);
export const INGEST_CHUNK_OVERLAP = Math.floor(INGEST_CHUNK_SIZE / 10);
export const PARENT_CHUNK_SIZE = Number(process.env.PARENT_CHUNK_SIZE ?? 1800);
export const CHILD_CHUNK_SIZE = Number(process.env.CHILD_CHUNK_SIZE ?? 400);
export const PARENT_CHILD_MODE = (process.env.PARENT_CHILD_MODE ?? 'parent') as 'parent' | 'window';
export const PARENT_CHILD_WINDOW = Number(process.env.PARENT_CHILD_WINDOW ?? 2);
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Reranking (Session 6). A broad candidate pool is retrieved by vector search,
// then a second-stage reranker reorders it and keeps the top `RERANK_TOP_N`.
export const CANDIDATE_POOL = Number(process.env.CANDIDATE_POOL ?? 30);
export const RERANK_TOP_N = Number(process.env.RERANK_TOP_N ?? DEFAULT_SEARCH_LIMIT);
export const RERANKER_PROVIDER = (process.env.RERANKER_PROVIDER ?? 'local') as 'local' | 'cohere';
export const SIMILARITY_THRESHOLD = 0.5;
export const TOOL_CONTENT_CAP = 800;
