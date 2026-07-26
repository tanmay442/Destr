type CitationIdentity = {
  id?: number | null;
  snippet: string;
  fileName?: string | null;
  page?: number | null;
};

export function dedupeCitations<T extends CitationIdentity>(citations: T[]): T[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = c.id != null ? `id:${c.id}` : `${c.fileName ?? ''}:${c.page ?? ''}:${c.snippet.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
