// HTML-entity encoder for user-supplied strings rendered in raw HTML
// contexts (dangerouslySetInnerHTML, emails, PDF exports).
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strip control characters (except newline/tab) and normalize whitespace.
export function sanitizeText(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}
