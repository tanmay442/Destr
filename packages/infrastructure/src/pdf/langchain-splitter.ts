/**
 * @deprecated Legacy whole-document splitter. Session 4 introduced the
 * pluggable `ChunkingStrategy` framework (see `@app/infrastructure/chunking`)
 * with `document-aware` as the default. This splitter is retained only as a
 * fallback / backward-compat path for seeding; it will be removed in a later
 * cleanup once CI proves the strategy path. Chunk size/overlap are config-driven
 * (Session 3): defaults 800/80 but overridable via INGEST_CHUNK_SIZE /
 * INGEST_CHUNK_OVERLAP env vars.
 */
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { TextSplitter } from '@app/domain';
import { INGEST_CHUNK_SIZE, INGEST_CHUNK_OVERLAP } from '../../../../config/constants';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: INGEST_CHUNK_SIZE,
  chunkOverlap: INGEST_CHUNK_OVERLAP,
});

export const langchainSplitter: TextSplitter = {
  async splitText(text: string): Promise<string[]> {
    return splitter.splitText(text);
  },
};
