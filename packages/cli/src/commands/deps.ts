import { createHash } from 'node:crypto';
import type { IngestDeps } from '@app/application/rag/ingest';
import type { PrechunkedIngestDeps } from '@app/application/rag/ingest-prechunked';
import type { ChunkingStrategyName } from '@app/infrastructure/chunking';
import type { MarkdownParser } from '@app/domain';
import { markdownParser } from '@app/infrastructure/markdown';
import { buildCoreDeps } from '@app/infrastructure/core';
import * as Pdf from '@app/infrastructure/pdf';
import * as Chunking from '@app/infrastructure/chunking';

type UploadIngestDeps = PrechunkedIngestDeps & { markdownParser: MarkdownParser };

function buildBaseDeps() {
  const core = buildCoreDeps({
    onQueueIngest: async () => {},
  });
  return {
    documents: core.documentRepo,
    chunks: core.chunkRepo,
    embeddings: core.embeddingService,
    embeddingModelId: core.embeddingModelId,
    contentParser: core.contentParser,
    pdfValidator: core.pdfValidator,
    blobStorage: core.blobStorage,
    hasher: { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') },
  };
}

export async function buildIngestDeps(): Promise<IngestDeps> {
  const base = buildBaseDeps();
  const strategyName = (process.env.CHUNKING_STRATEGY ?? 'document-aware') as ChunkingStrategyName;
  const useStrategy = !process.env.SEED_LEGACY_SPLITTER;
  return {
    documents: base.documents,
    chunks: base.chunks,
    embeddings: base.embeddings,
    hasher: base.hasher,
    pdfParser: Pdf.unpdfParser,
    textSplitter: Pdf.langchainSplitter,
    contentParser: useStrategy ? base.contentParser : undefined,
    chunkingStrategy: useStrategy
      ? Chunking.getChunkingStrategy(strategyName, { embeddings: base.embeddings, modelId: base.embeddingModelId })
      : undefined,
  };
}

export async function buildUploadDeps(): Promise<UploadIngestDeps> {
  const base = buildBaseDeps();
  return {
    documents: base.documents,
    chunks: base.chunks,
    embeddings: base.embeddings,
    hasher: base.hasher,
    blobStorage: base.blobStorage,
    pdfValidator: base.pdfValidator,
    markdownParser,
  };
}
