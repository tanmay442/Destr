type CitationIdentity = {
  id?: number | null;
  chunkUid?: string | null;
  documentId?: number | null;
  chunkIndex?: number | null;
  snippet: string;
  fileName?: string | null;
  page?: number | null;
};

export function dedupeCitations<T extends CitationIdentity>(citations: T[]): T[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = c.chunkUid?.trim()
      ? `chunk_uid:${c.chunkUid.trim()}`
      : c.documentId != null && c.chunkIndex != null
        ? `document_chunk:${c.documentId}:${c.chunkIndex}`
        : c.id != null
          ? `id:${c.id}`
          : `${c.fileName ?? ''}:${c.page ?? ''}:${c.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
