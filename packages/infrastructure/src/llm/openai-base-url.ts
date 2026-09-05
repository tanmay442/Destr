/**
 * Normalize an OpenAI-compatible base URL so the SDK appends its operation
 * path (`/chat/completions`, `/responses`, `/embeddings`) at the right root.
 *
 * - Strips trailing slashes and any path beyond `/v1` (e.g. `/v1/responses`).
 * - Appends `/v1` when the host exposes the API at the root and no `/v1`
 *   segment is present, so `http://host:1234` becomes `http://host:1234/v1`.
 */
export function normalizeOpenAIBaseURL(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '');
  const atV1 = url.match(/^(.*?\/v1)(\/.*)?$/i);
  return atV1 ? (atV1[1] ?? url) : `${url}/v1`;
}

export type OpenAIOperationPath = '/responses' | '/chat/completions';

const RESPONSES_OPERATION_PATH: OpenAIOperationPath = '/responses';
const CHAT_OPERATION_PATH: OpenAIOperationPath = '/chat/completions';

/**
 * Identify the operation represented by a configured endpoint without
 * retaining or exposing query/fragment values (which may contain secrets).
 * Unknown and root paths intentionally remain Chat Completions-compatible.
 */
export function getOpenAIOperationPath(raw: string): OpenAIOperationPath {
  const path = (raw.split(/[?#]/u, 1)[0] ?? '').trim().replace(/\/+$/, '').toLowerCase();
  return path.endsWith(RESPONSES_OPERATION_PATH) ? RESPONSES_OPERATION_PATH : CHAT_OPERATION_PATH;
}
