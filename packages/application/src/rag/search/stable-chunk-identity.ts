interface StableChunkCoordinates {
  readonly chunkUid?: string | null | undefined;
  readonly documentId: number;
  readonly chunkIndex: number;
  readonly constituentChunks?: readonly StableChunkCoordinates[] | undefined;
}

/** All durable identities represented by model-visible resolved content. */
export function stableChunkIdentities(chunk: StableChunkCoordinates): readonly string[] {
  const constituents = chunk.constituentChunks;
  return constituents && constituents.length > 0
    ? [...new Set(constituents.flatMap(stableChunkIdentities))]
    : [stableChunkIdentity(chunk)];
}

/** Stable retrieval identity: durable UID first, document position otherwise. */
export function stableChunkIdentity(chunk: StableChunkCoordinates): string {
  const chunkUid = chunk.chunkUid?.trim();
  return chunkUid
    ? `chunk_uid:${chunkUid}`
    : `document_chunk:${chunk.documentId}:${chunk.chunkIndex}`;
}
