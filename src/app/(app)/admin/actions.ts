'use server';

import { revalidatePath } from 'next/cache';
import { getComposition, requireAdmin, ForbiddenError } from '@/composition';
import { UnauthorizedError } from '@app/domain';
import type { TicketStatus } from '@app/application/admin/tickets';
import type { AppRole } from '@app/infrastructure/auth';
import { toSafeError } from '@/lib/http';
import { sanitizeText } from '@/lib/sanitize';
import { logger } from '@/lib/logger';

async function requireAdminOrError(): Promise<
  | { user: { id: string; email: string; name: string; imageUrl: string | null; role: 'admin' | 'user' } }
  | { error: string }
> {
  try {
    return await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return { error: 'Unauthorized' };
    }
    if (err instanceof ForbiddenError) {
      return { error: 'Forbidden' };
    }
    if (
      err &&
      typeof err === 'object' &&
      (err as { status?: number }).status === 403
    ) {
      return { error: 'Forbidden' };
    }
    throw err;
  }
}

export interface UploadState {
  error?: string;
  status?: 'inserted' | 'updated' | 'unchanged' | 'queued';
  chunks?: number;
  fileName?: string;
  documentId?: number;
}

export async function uploadPdfAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { error: 'No PDF uploaded.' };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 4 || buffer.toString('utf8', 0, 4) !== '%PDF') {
    return { error: 'Only PDF files are supported.' };
  }
  if (file.size > 20 * 1024 * 1024) {
    return { error: 'File too large (max 20 MB).' };
  }
  try {
    const result = await getComposition().uploadPdf({
      fileName: file.name,
      buffer,
      actorId: session.user.id,
    });
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin');
    revalidatePath('/admin/upload');
    revalidatePath('/admin/documents');
    return {
      status: result.value.status,
      chunks: result.value.chunks,
      fileName: file.name,
      documentId: result.value.documentId,
    };
  } catch (err) {
    logger.error('uploadPdfAction failed', { error: err });
    return toSafeError(err);
  }
}

export async function deleteDocumentAction(
  documentId: number,
): Promise<{ error?: string }> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().softDeleteDocument({ documentId, actorId: session.user.id });
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/documents');
    return {};
  } catch (err) {
    logger.error('deleteDocumentAction failed', { error: err });
    return toSafeError(err);
  }
}

export async function restoreDocumentAction(
  documentId: number,
): Promise<{ error?: string }> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().restoreDocument(documentId, session.user.id);
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/documents');
    return {};
  } catch (err) {
    logger.error('restoreDocumentAction failed', { error: err });
    return toSafeError(err);
  }
}

export async function hardDeleteDocumentAction(
  documentId: number,
): Promise<{ error?: string }> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().hardDeleteDocument({ documentId, actorId: session.user.id });
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/documents');
    return {};
  } catch (err) {
    logger.error('hardDeleteDocumentAction failed', { error: err });
    return toSafeError(err);
  }
}

export interface SetRoleResult {
  error?: string;
}

export async function setRoleAction(
  clerkUserId: string,
  role: AppRole,
): Promise<SetRoleResult> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  if (role !== 'admin' && role !== 'user') {
    return { error: 'Invalid role' };
  }
  try {
    const result = await getComposition().setUserRole({ clerkUserId, role, actorId: session.user.id });
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/users');
    return {};
  } catch (err) {
    logger.error('setRoleAction failed', { error: err });
    return toSafeError(err);
  }
}

export interface UpdateTicketInput {
  status?: TicketStatus;
  assignedTo?: string | null;
  note?: string;
}

export async function updateTicketAction(
  ticketId: string,
  patch: UpdateTicketInput,
): Promise<{ error?: string }> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().updateTicket({
      ticketId,
      status: patch.status,
      assignedTo: patch.assignedTo,
      note: patch.note ? sanitizeText(patch.note) : undefined,
      actorId: session.user.id,
    });
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/tickets');
    return {};
  } catch (err) {
    logger.error('updateTicketAction failed', { error: err });
    return toSafeError(err);
  }
}

export interface RecountChunksResult {
  error?: string;
  count?: number;
}

export async function recountChunksAction(
  documentId: number,
): Promise<RecountChunksResult> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().recountChunksForDocument(documentId);
    if (!result.ok) return toSafeError(result.error);
    revalidatePath('/admin/documents');
    return { count: result.value.count };
  } catch (err) {
    logger.error('recountChunksAction failed', { error: err });
    return toSafeError(err);
  }
}

export interface RecountAllChunksResult {
  error?: string;
  documents?: number;
  total?: number;
}

export async function recountAllChunksAction(): Promise<RecountAllChunksResult> {
  const session = await requireAdminOrError();
  if ('error' in session) return session;
  try {
    const result = await getComposition().recountChunksForAllDocuments();
    if (!result.ok) return toSafeError(result.error);
    const total = result.value.reduce((acc, r) => acc + r.count, 0);
    revalidatePath('/admin/documents');
    return { documents: result.value.length, total };
  } catch (err) {
    logger.error('recountAllChunksAction failed', { error: err });
    return toSafeError(err);
  }
}
