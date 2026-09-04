import { createChunkStore } from '../chunk-store';
import { createLexicalSearch } from '../lexical-search';
import { createVectorSearch } from '../vector-search';
import { defaultHasher } from '../stable-identities';
import type { ChunkRepository, ChunkStore, Hasher, LexicalSearch, VectorSearch } from '@app/domain';
import type { Client } from './shared';

export { searchChunksByVector } from '../vector-search';
export { searchChunksByLexical } from '../lexical-search';
export {
  insertChunks,
  replaceChunks,
  getChunksByIds,
  getChunksByDocAndRange,
  getChunksByDocAndRanges,
  deleteChunksByDocumentId,
  countChunksForDocuments,
  countChunksForAll,
  countChunksForDocument,
  recountChunksForAll,
} from '../chunk-store';

export function createChunkRepositoryCompat(
  store: ChunkStore,
  vector: VectorSearch,
  lexical: LexicalSearch,
): ChunkRepository {
  return {
    searchByVector: (embedding, opts) => vector.searchByVector(embedding, opts),
    searchByLexical: (query, opts) => lexical.searchByLexical(query, opts),
    getByIds: (ids) => store.getByIds(ids),
    getByDocAndRange: (documentId, start, end) => store.getByDocAndRange(documentId, start, end),
    getByDocAndRanges: (ranges) => store.getByDocAndRanges(ranges),
    insertMany: (rows) => store.insertMany(rows),
    replaceMany: async (documentId, rows) => {
      if (store.replaceMany) {
        await store.replaceMany(documentId, rows);
        return;
      }
      await store.deleteByDocumentId(documentId);
      await store.insertMany(rows);
    },
    deleteByDocumentId: (documentId) => store.deleteByDocumentId(documentId),
    countForDocuments: (ids) => store.countForDocuments(ids),
    countForAll: () => store.countForAll(),
    countForDocument: (id) => store.countForDocument(id),
    recountAll: () => store.recountAll(),
  };
}

export function createChunkRepo(
  client: Client,
  vectorDim?: number,
  hasher: Hasher = defaultHasher,
): ChunkRepository {
  return createChunkRepositoryCompat(
    createChunkStore(client, vectorDim, hasher),
    createVectorSearch(client, vectorDim),
    createLexicalSearch(client),
  );
}
