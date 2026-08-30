type CitationIdentity = {
  id?: number | null;
  chunkUid?: string | null;
  snippet: string;
  fileName?: string | null;
  page?: number | null;
};

export function dedupeCitations<T extends CitationIdentity>(citations: T[]): T[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = c.chunkUid
      ? `uid:${c.chunkUid}`
      : c.id != null
        ? `id:${c.id}`
        : `${c.fileName ?? ''}:${c.page ?? ''}:${c.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
