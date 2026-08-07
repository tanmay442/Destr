import { createHash } from 'node:crypto';
import type { IngestDeps } from '@app/application/rag/ingest';
import type { PrechunkedIngestDeps } from '@app/application/rag/ingest-prechunked';
import type { ChunkingStrategyName } from '@app/infrastructure/chunking';
import type { MarkdownParser } from '@app/domain';
import { markdownParser } from '@app/infrastructure/markdown';
import * as Db from '@app/infrastructure/db';
import { createRepositoryAdapters } from '@app/infrastructure/db';
import * as Llm from '@app/infrastructure/llm';
import * as Pdf from '@app/infrastructure/pdf';
import * as Chunking from '@app/infrastructure/chunking';
import { createBlobStorage } from '@app/infrastructure/storage';

type UploadIngestDeps = PrechunkedIngestDeps & { markdownParser: MarkdownParser };

async function buildDbDeps() {
  const adapters = createRepositoryAdapters(Db.db);
  const embeddings = Llm.getEmbeddingService();
  const hasher = { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') };
  return {
    documents: adapters.documents,
    chunks: adapters.chunks,
    embeddings,
    hasher,
  };
}

export async function buildIngestDeps(): Promise<IngestDeps> {
  const base = await buildDbDeps();
  const strategyName = (process.env.CHUNKING_STRATEGY ?? 'document-aware') as ChunkingStrategyName;
  const useStrategy = !process.env.SEED_LEGACY_SPLITTER;
  return {
    ...base,
    pdfParser: Pdf.unpdfParser,
    textSplitter: Pdf.langchainSplitter,
    contentParser: useStrategy ? Pdf.unpdfParser : undefined,
    chunkingStrategy: useStrategy
      ? Chunking.getChunkingStrategy(strategyName, { embeddings: base.embeddings })
      : undefined,
  };
}

export async function buildUploadDeps(): Promise<UploadIngestDeps> {
  const base = await buildDbDeps();
  return {
    ...base,
    blobStorage: createBlobStorage(),
    markdownParser,
  };
}

