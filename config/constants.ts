// Centralised business-logic constants. Keep sorted alphabetically.
// Tune these to change behaviour without hunting through source files.
//
// TODO: Add tests for rate limiter concurrency, ticket ID collision,
// embedding batch retry logic, and composition root wiring.

export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
export const CITATION_SNIPPET_MAX = 150;
export const DEFAULT_SEARCH_LIMIT = 3;
export const MD_CHUNK_DELIMITER = process.env.MD_CHUNK_DELIMITER ?? '---chunk---';
export const EMBEDDING_BATCH_CONCURRENCY = 3;
export const EMBEDDING_BATCH_SIZE = 50;
export const MAX_AUDIT_LIMIT = 200;
export const MAX_LIST_LIMIT = 100;
export const MAX_TICKET_NOTES_LENGTH = 10_000;
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const SIMILARITY_THRESHOLD = 0.5;
export const TOOL_CONTENT_CAP = 800;
