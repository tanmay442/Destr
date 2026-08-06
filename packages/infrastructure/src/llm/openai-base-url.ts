/**
 * Normalize an OpenAI-compatible base URL so the SDK appends its operation
 * path (`/chat/completions`, `/embeddings`) at the right root.
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
