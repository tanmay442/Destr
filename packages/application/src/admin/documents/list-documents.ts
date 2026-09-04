import { ok, type Result, ValidationError } from '@app/domain';
import type {
  DocumentRepository,
  ChunkRepository,
  UserRepository,
  IngestStatus,
  CursorPageInfo,
  ListCursorCodec,
} from '@app/domain';
import { MAX_LIST_LIMIT } from '@app/domain';
import {
  decodeCursorAtBoundary,
  wrapServiceCall,
  sanitizePagination,
} from '../../service-result';
import { createListCursorContext } from '@app/domain';
import { requireAdminActor } from '../authz';

interface ListDocumentsInput {
  search?: string | undefined;
  includeDeleted?: boolean | undefined;
  limit?: number;
  offset?: number;
  cursor?: unknown;
  before?: unknown;
}

export async function listDocuments(
  input: ListDocumentsInput & { actorId: string },
  deps: {
    documents: DocumentRepository;
    chunks: ChunkRepository;
    users: UserRepository;
    cursorCodec: ListCursorCodec;
  },
): Promise<
  Result<{
    documents: Array<{
      id: number;
      fileName: string;
      fileHash: string;
      uploadedBy: string;
      uploadedAt: Date;
      storageKey: string | null;
      ingestStatus: IngestStatus;
      deletedAt: Date | null;
      uploaderName: string | null;
      chunkCount: number;
      hasBlob: boolean;
    }>;
    total: number;
  } & CursorPageInfo>
> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    const search = input.search?.trim() || undefined;
    const includeDeleted = input.includeDeleted === true;
    const includeDeletedOption = includeDeleted;
    const cursorContext = createListCursorContext('documents', { search: search ?? null, includeDeleted });
    const cursor = decodeCursorAtBoundary(input.cursor, 'documents', deps.cursorCodec, cursorContext);
    const before = decodeCursorAtBoundary(input.before, 'documents', deps.cursorCodec, cursorContext);
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const { documents, total, nextCursor, previousCursor } = await deps.documents.list({
      search,
      includeDeleted: includeDeletedOption,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
      cursorCodec: deps.cursorCodec,
      cursorContext,
    });
    const ids = documents.map((d) => d.id);
    const chunkCounts =
      ids.length > 0
        ? await deps.chunks.countForDocuments(ids)
        : new Map<number, number>();
    const uploaderIds = [...new Set(documents.map((d) => d.uploadedBy))];
    const uploaders =
      uploaderIds.length > 0 ? await deps.users.findByIds(uploaderIds) : [];
    const uploaderMap = new Map<string, string | null>();
    for (const u of uploaders) {
      uploaderMap.set(u.clerkUserId, u.name ?? null);
    }
    const result = documents.map((d) => ({
      ...d,
      hasBlob: Boolean(d.hasBlob),
      uploaderName: uploaderMap.get(d.uploadedBy) ?? null,
      chunkCount: chunkCounts.get(d.id) ?? 0,
    }));
    return ok({
      documents: result,
      total,
      nextCursor: nextCursor ?? null,
      previousCursor: previousCursor ?? null,
    });
  }, 'Failed to list documents');
}
