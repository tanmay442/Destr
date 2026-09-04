export interface DocumentChunkInit {
  content: string;
  chunkIndex: number;
  page: number;
  modelId: string;
  sectionTitle?: string | null;
  source?: string;
  parentChunkId?: number | null;
  kind?: 'parent' | 'child' | 'summary';
}

/** Build a `DocumentChunk`, assembling the shared metadata fields. */
export function makeDocumentChunk(init: DocumentChunkInit) {
  return {
    content: init.content,
    chunkIndex: init.chunkIndex,
    page: init.page,
    sectionTitle: init.sectionTitle ?? null,
    source: init.source ?? `Page ${init.page}`,
    embeddingModel: init.modelId,
    parentChunkId: init.parentChunkId ?? null,
    kind: init.kind ?? 'child',
  };
}
