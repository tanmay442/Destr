type CitationIdentity = {
  snippet: string;
  fileName?: string | null;
  page?: number | null;
};

export function dedupeCitations<T extends CitationIdentity>(citations: T[]): T[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = `${c.fileName ?? ''}:${c.page ?? ''}:${c.snippet.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
