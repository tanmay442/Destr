import { err, ok, type Result, ValidationError, ExternalServiceError } from '@app/domain';
import type { DocumentRepository, ChunkRepository } from '@app/domain';
import type { EmbeddingService } from '@app/domain';
import type { Hasher } from '@app/domain';
import type { PdfParser } from '@app/domain';
import type { TextSplitter } from '@app/domain';

interface IngestFileInput {
  fileName: string;
  buffer: Buffer;
  uploadedBy: string;
}

export interface IngestResult {
  documentId: number;
  chunks: number;
  status: 'inserted' | 'updated' | 'unchanged' | 'queued';
}

/** Dependencies required by the ingest pipeline. Each property
 *  maps to a port interface from the application layer. */
export interface IngestDeps {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  embeddings: EmbeddingService;
  hasher: Hasher;
  pdfParser: PdfParser;
  textSplitter: TextSplitter;
}

export async function ingestFile(
  input: IngestFileInput,
  deps: IngestDeps,
): Promise<Result<IngestResult>> {
  const { fileName, buffer, uploadedBy } = input;
  const fileHash = deps.hasher.sha256(buffer);

  const existing = await deps.documents.findByName(fileName);
  if (existing && existing.fileHash === fileHash) {
    return ok({ documentId: existing.id, chunks: 0, status: 'unchanged' });
  }

  let text: string;
  try {
    text = await deps.pdfParser.extractText(buffer);
  } catch (cause) {
    return err(new ExternalServiceError('PDF parsing failed', cause));
  }
  const texts = await deps.textSplitter.splitText(text);
  if (texts.length === 0) {
    return err(new ValidationError(`No extractable text in ${fileName}`));
  }
  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(texts);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }

  if (embeddings.length !== texts.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }

  // NOTE: Callers should wrap these operations in a database transaction
  // when atomicity is required (see TransactionRunner).
  if (existing) {
    await deps.documents.deleteById(existing.id);
  }

  const inserted = await deps.documents.insert({
    fileName,
    fileHash,
    uploadedBy,
  });

  await deps.chunks.insertMany(
    texts.map((t, i) => ({
      documentId: inserted.id,
      content: t,
      embedding: embeddings[i],
    })),
  );

  return ok({
    documentId: inserted.id,
    chunks: texts.length,
    status: existing ? 'updated' : 'inserted',
  });
}

export interface PreparedChunk {
  documentId: number;
  content: string;
  embedding: number[];
}

/** Parse, split, and embed a PDF buffer for a document row that
 *  already exists (created by the async queued-upload path with
 *  `ingest_status = 'queued'`). Unlike `ingestFile`, this does NOT
 *  look up or delete rows by name, and does NOT insert a document
 *  row — the row is already there. Returns the prepared chunk rows;
 *  the caller inserts them, typically inside a transaction together
 *  with the `done` status flip so the chunk insert and status update
 *  are atomic (and a QStash retry that sees `done` is a no-op). */
export async function prepareIngest(
  input: { documentId: number; fileName: string; buffer: Buffer },
  deps: { embeddings: EmbeddingService; pdfParser: PdfParser; textSplitter: TextSplitter },
): Promise<Result<{ chunks: number; rows: PreparedChunk[] }>> {
  let text: string;
  try {
    text = await deps.pdfParser.extractText(input.buffer);
  } catch (cause) {
    return err(new ExternalServiceError('PDF parsing failed', cause));
  }
  const texts = await deps.textSplitter.splitText(text);
  if (texts.length === 0) {
    return err(new ValidationError(`No extractable text in ${input.fileName}`));
  }
  let embeddings: number[][];
  try {
    embeddings = await deps.embeddings.embedBatch(texts);
  } catch (cause) {
    return err(new ExternalServiceError('Embedding API failed', cause));
  }
  if (embeddings.length !== texts.length) {
    return err(new ExternalServiceError('Embedding count mismatch'));
  }
  const rows = texts.map((t, i) => ({
    documentId: input.documentId,
    content: t,
    embedding: embeddings[i],
  }));
  return ok({ chunks: texts.length, rows });
}
