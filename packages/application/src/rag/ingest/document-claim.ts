import type { DocumentRepository, IngestStatus } from '@app/domain';
import { RESTORE_WINDOW_MS } from '@app/domain';

export const UPLOAD_CONFLICT_MESSAGE =
  'A document with this file name was uploaded by another request; retry the upload';

function isDocumentNameConflict(error: unknown): boolean {
  const wrapped = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const pgError = wrapped.code ? wrapped : wrapped.cause;
  return pgError?.code === '23505' && pgError.constraint === 'documents_file_name_unique';
}

export { isDocumentNameConflict };

export interface RowPrevious {
  fileHash: string | null;
  status: IngestStatus | null;
  storageKey: string | null;
}

export type DocumentNameClaim =
  | { kind: 'unchanged'; documentId: number; restore: boolean }
  | { kind: 'replace'; documentId: number; previous: RowPrevious }
  | { kind: 'resurrect'; documentId: number; previous: RowPrevious }
  | { kind: 'insert'; oldStorageKey: string | null };

export async function claimDocumentByName(
  fileName: string,
  fileHash: string,
  documents: DocumentRepository,
): Promise<DocumentNameClaim> {
  const row = await (documents.findByNameForUpdate?.(fileName, { includeDeleted: true }) ?? documents.findByName(fileName, { includeDeleted: true }));
  if (!row) return { kind: 'insert', oldStorageKey: null };
  if (!row.deletedAt) {
    if (row.fileHash === fileHash) return { kind: 'unchanged', documentId: row.id, restore: false };
    return {
      kind: 'replace',
      documentId: row.id,
      previous: { fileHash: row.fileHash, status: row.ingestStatus, storageKey: row.storageKey },
    };
  }
  if (Date.now() - row.deletedAt.getTime() <= RESTORE_WINDOW_MS) {
    if (row.fileHash === fileHash) return { kind: 'unchanged', documentId: row.id, restore: true };
    return {
      kind: 'resurrect',
      documentId: row.id,
      previous: { fileHash: row.fileHash, status: row.ingestStatus, storageKey: row.storageKey },
    };
  }
  return { kind: 'insert', oldStorageKey: row.storageKey };
}

export async function nameStillClaimed(
  fileName: string,
  fileHash: string,
  documents: DocumentRepository,
): Promise<boolean> {
  const row = await documents.findByName(fileName);
  return row !== null && row.fileHash === fileHash;
}
