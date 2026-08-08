/**
 * @deprecated Legacy whole-document splitter. The pluggable `ChunkingStrategy`
 * framework (see `@app/infrastructure/chunking`) with `document-aware` as the
 * default is preferred. This splitter is retained only as a fallback /
 * backward-compat path for seeding. Chunk size/overlap are config-driven:
 * defaults 800/80 but overridable via INGEST_CHUNK_SIZE /
 * INGEST_CHUNK_OVERLAP env vars.
 */
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { TextSplitter } from '@app/domain';
import { INGEST_CHUNK_SIZE, INGEST_CHUNK_OVERLAP } from '@app/infrastructure/config';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: INGEST_CHUNK_SIZE,
  chunkOverlap: INGEST_CHUNK_OVERLAP,
});

export const langchainSplitter: TextSplitter = {
  async splitText(text: string): Promise<string[]> {
    return splitter.splitText(text);
  },
};
