import { err, ok, type Result, ConflictError } from '@app/domain';
import type {
  DocumentRepository, ChunkRepository, EmbeddingService,
  Hasher, PdfParser, TextSplitter, TransactionRunner,
  ContentParser, ChunkingStrategy, DocSummarizer,
} from '@app/domain';
import { UPLOAD_CONFLICT_MESSAGE, isDocumentNameConflict, claimDocumentByName, nameStillClaimed } from './document-claim';
import { parseAndEmbed, type ParseDeps, type PreparedChunk } from './parse-embed';
import { writeChunks } from './write-chunks';

export interface IngestFileInput {
  fileName: string;
  buffer: Uint8Array;
  uploadedBy: string;
  signal?: AbortSignal | undefined;
}

export interface IngestResult {
  documentId: number;
  chunks: number;
  status: 'inserted' | 'updated' | 'unchanged' | 'queued';
}

export interface IngestDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  hasher: Hasher;
  pdfParser: PdfParser;
  textSplitter: TextSplitter;
  /** Optional: when present, chunking uses the new strategy path instead of the legacy TextSplitter. */
  contentParser?: ContentParser | undefined;
  chunkingStrategy?: ChunkingStrategy | undefined;
  /** Optional Contextual-Chunk-Header summarizer. */
  summarizer?: DocSummarizer | undefined;
  /** Optional transaction runner used to make the upsert+replace-chunks sequence atomic. */
  runner?: TransactionRunner | undefined;
  /** Override the CCH toggle. */
  cchEnabled?: boolean | undefined;
}

export async function ingestFile(
  input: IngestFileInput,
  deps: IngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, buffer, uploadedBy, signal } = input;
  const fileHash = deps.hasher.sha256(buffer);

  const parsed = await parseAndEmbed({ fileName, buffer, signal }, deps);
  if (!parsed.ok) return parsed;

  const write = async (
    documents: DocumentRepository,
    chunks: ChunkRepository,
  ): Promise<Result<IngestResult>> => {
    const claim = await claimDocumentByName(fileName, fileHash, documents);
    if (claim.kind === 'unchanged') {
      if (claim.restore) await documents.restore(claim.documentId);
      return ok({ documentId: claim.documentId, chunks: 0, status: 'unchanged' });
    }
    const outcome = await writeChunks(
      documents,
      chunks,
      { fileName, fileHash, uploadedBy, resurrectDeleted: claim.kind === 'resurrect' },
      parsed.value.rows,
    );
    if (!(await nameStillClaimed(fileName, fileHash, documents))) {
      throw new ConflictError(UPLOAD_CONFLICT_MESSAGE);
    }
    return ok({
      documentId: outcome.documentId,
      chunks: parsed.value.chunks,
      status: claim.kind === 'replace' ? 'updated' : 'inserted',
    });
  };

  try {
    return deps.runner
      ? await deps.runner.run((ctx) => write(ctx.documents, ctx.chunks))
      : await write(deps.documents, deps.chunks);
  } catch (error) {
    if (isDocumentNameConflict(error)) return err(new ConflictError(UPLOAD_CONFLICT_MESSAGE));
    if (error instanceof ConflictError) return err(error);
    throw error;
  }
}

/** Parse/split/embed for an existing `queued` row; caller inserts chunks + flips status atomically. */
export async function prepareIngest(
  input: { documentId: number; fileName: string; buffer: Uint8Array; signal?: AbortSignal | undefined },
  deps: ParseDeps,
): Promise<Result<{ chunks: number; rows: PreparedChunk[] }>> {
  const parsed = await parseAndEmbed(input, deps);
  if (!parsed.ok) return parsed;
  return ok({
    chunks: parsed.value.chunks,
    rows: parsed.value.rows.map((r) => ({ ...r, documentId: input.documentId })),
  });
}
