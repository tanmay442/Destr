import { resolveVectorDimForClient } from '../schema-vector';
import { defaultHasher } from '../stable-identities';
import type { ChunkStore, Hasher } from '@app/domain';
import type { Client } from './shared';
import { countChunksForAll, countChunksForDocument, countChunksForDocuments, recountChunksForAll } from './counts';
import { deleteChunksByDocumentId, insertChunks, replaceChunks } from './writes';
import { getChunksByDocAndRange, getChunksByDocAndRanges, getChunksByIds } from './reads';

export function createChunkStore(
  client: Client,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): ChunkStore {
  const expectedDimension = vectorDim ?? resolveVectorDimForClient(client);
  return {
    getByIds: (ids, opts) => getChunksByIds(ids, client, opts),
    getByDocAndRange: (documentId, start, end, opts) => getChunksByDocAndRange(documentId, start, end, client, opts),
    getByDocAndRanges: (ranges, opts) => getChunksByDocAndRanges(ranges, client, opts),
    insertMany: (rows) => insertChunks(rows, client, expectedDimension, hasher),
    replaceMany: (documentId, rows) => replaceChunks(documentId, rows, client, expectedDimension, hasher),
    deleteByDocumentId: (documentId) => deleteChunksByDocumentId(documentId, client),
    countForDocuments: (ids) => countChunksForDocuments(ids, client),
    countForAll: () => countChunksForAll(client),
    countForDocument: (id) => countChunksForDocument(id, client),
    recountAll: () => recountChunksForAll(client),
  };
}
