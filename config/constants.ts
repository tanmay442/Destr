// Centralised business-logic constants. Keep sorted alphabetically.
// Tune these to change behaviour without hunting through source files.
//
// TODO: Add tests for rate limiter concurrency, ticket ID collision,
// embedding batch retry logic, and composition root wiring.

export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
export const CHAT_MAX_BODY_BYTES = 1_000_000; // 1 MB hard cap on chat POST body
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
// then an optional second-stage reranker reorders it and keeps the top
// `RERANK_TOP_N`. `RERANKER_PROVIDER` selects the reranker:
//   - 'cosine'  : the original pre-Session-6 bi-encoder ordering. No reranker
//                   is loaded — the safe serverless-default (zero native deps).
//   - 'local'   : on-device Xenova cross-encoder (no API key). Opt-in.
//   - 'cohere'  : hosted Cohere Rerank API (needs COHERE_API_KEY). Opt-in.
// When 'local'/'cohere' fail to load/call, `searchChunks` automatically
// falls back to cosine ordering.
export const RERANKER_PROVIDER = (process.env.RERANKER_PROVIDER ?? 'cosine') as 'cosine' | 'local' | 'cohere';
export const CANDIDATE_POOL = Number(process.env.CANDIDATE_POOL ?? 30);
export const RERANK_TOP_N = Number(process.env.RERANK_TOP_N ?? DEFAULT_SEARCH_LIMIT);
// Hybrid retrieval (Session 7): fuse vector + BM25 lexical via Reciprocal Rank
// Fusion. `HYBRID_ENABLED` toggles the lexical branch; `RRF_K` is the rank
// damping constant; `LEXICAL_WEIGHT` boosts the lexical branch's RRF score.
export const HYBRID_ENABLED = process.env.HYBRID_ENABLED !== 'false';
export const RRF_K = Number(process.env.RRF_K ?? 60);
export const LEXICAL_WEIGHT = Number(process.env.LEXICAL_WEIGHT ?? 1);
export const SIMILARITY_THRESHOLD = 0.5;
export const TOOL_CONTENT_CAP = 800;
// Agentic retrieval loop (Session 8): query-rewrite → hybrid/rerank retrieve →
// grade+drop irrelevant → retry if weak → generate → hallucination check.
export const AGENTIC_ENABLED = process.env.AGENTIC_ENABLED !== 'false'; // default on
export const GRADE_MODEL = process.env.GRADE_MODEL ?? ''; // optional cheap model override for graders
export const OUT_OF_DOMAIN_THRESHOLD = Number(process.env.OUT_OF_DOMAIN_THRESHOLD ?? 0.3);
export const AGENT_STEP_BUDGET = Number(process.env.AGENT_STEP_BUDGET ?? 8);
// Broad candidate pool for the agentic loop's re-retrieval (step-back / sub-query).
export const AGENTIC_RETRIEVE_LIMIT = Number(process.env.AGENTIC_RETRIEVE_LIMIT ?? 10);
// Max rewrite+retry passes before falling back to the ticket offer.
export const AGENTIC_MAX_RETRIES = Number(process.env.AGENTIC_MAX_RETRIES ?? 1);
// Answer cache (Session 10): keyed on normalised query + embedding/chat model
// ids, stored in the same Upstash Redis as the rate-limiter. TTL bounds how long
// a (possibly model-pinned) answer stays served without regeneration.
export const ANSWER_CACHE_ENABLED = process.env.ANSWER_CACHE_ENABLED !== 'false'; // default on
export const ANSWER_CACHE_TTL_SEC = Number(process.env.ANSWER_CACHE_TTL_SEC ?? 3600);
// Tracing spans (Session 10): emit structured `logger.info('rag.*')` spans
// around retrieval + agentic steps. Off by default to avoid log noise.
export const TRACE_ENABLED = process.env.TRACE_ENABLED === 'true';
// Eval harness (Session 10): CI gate — fail when mean faithfulness/relevancy
// drops below this. The harness itself is opt-in (not run in unit CI by default).
export const EVAL_FAITHFULNESS_THRESHOLD = Number(process.env.EVAL_FAITHFULNESS_THRESHOLD ?? 0.7);
