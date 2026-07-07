import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, ExternalServiceError } from '@app/domain';

const { requireAdminMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
}));

const {
  uploadPdfMock,
  replacePdfMock,
  softDeleteDocumentMock,
  restoreDocumentMock,
  hardDeleteDocumentMock,
  recountChunksForDocumentMock,
  recountChunksForAllDocumentsMock,
  setUserRoleMock,
  updateTicketMock,
  revalidatePathMock,
  redirectMock,
} = vi.hoisted(() => ({
  uploadPdfMock: vi.fn(),
  replacePdfMock: vi.fn(),
  softDeleteDocumentMock: vi.fn(),
  restoreDocumentMock: vi.fn(),
  hardDeleteDocumentMock: vi.fn(),
  recountChunksForDocumentMock: vi.fn(),
  recountChunksForAllDocumentsMock: vi.fn(),
  setUserRoleMock: vi.fn(),
  updateTicketMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  redirectMock: vi.fn(),
}));

vi.mock('@/composition', async () => {
  const { ForbiddenError, UnauthorizedError, ok, err } = await import('@app/domain');
  return {
    requireAdmin: requireAdminMock,
    requireSession: requireAdminMock,
    getAppSession: vi.fn(),
    ForbiddenError,
    UnauthorizedError,
    unwrap: <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
      if (r.ok) return r.value;
      throw r.error;
    },
    respond: (e: unknown) => new Response(JSON.stringify(e), { status: 500 }),
    respondResult: <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): Response => {
      if (r.ok) return Response.json(r.value);
      return new Response(JSON.stringify(e), { status: 500 });
      function e(): unknown { return r.ok ? r.value : r.error; }
    },
    toActionResult: <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T | { error: string; code: string } => {
      if (r.ok) return r.value;
      return { error: 'An error occurred', code: 'internal_error' };
    },
    isActionError: (r: unknown): r is { error: string; code: string } =>
      typeof r === 'object' && r !== null && 'error' in r && 'code' in r,
    ok,
    err,
    getComposition: () => ({
      uploadPdf: uploadPdfMock,
      replacePdf: replacePdfMock,
      softDeleteDocument: softDeleteDocumentMock,
      restoreDocument: restoreDocumentMock,
      hardDeleteDocument: hardDeleteDocumentMock,
      recountChunksForDocument: recountChunksForDocumentMock,
      recountChunksForAllDocuments: recountChunksForAllDocumentsMock,
      setUserRole: setUserRoleMock,
      updateTicket: updateTicketMock,
    }),
  };
});

vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));

import {
  uploadPdfAction,
  deleteDocumentAction,
  restoreDocumentAction,
  setRoleAction,
  updateTicketAction,
  recountChunksAction,
  recountAllChunksAction,
} from './actions';

beforeEach(() => {
  requireAdminMock.mockReset();
  uploadPdfMock.mockReset();
  replacePdfMock.mockReset();
  softDeleteDocumentMock.mockReset();
  restoreDocumentMock.mockReset();
  hardDeleteDocumentMock.mockReset();
  recountChunksForDocumentMock.mockReset();
  recountChunksForAllDocumentsMock.mockReset();
  setUserRoleMock.mockReset();
  updateTicketMock.mockReset();
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
});

describe('admin actions', () => {
  it('uploadPdfAction 403s when requireAdmin throws', async () => {
    const forbiddenError = new Error('Forbidden') as Error & { status: number };
    forbiddenError.status = 403;
    requireAdminMock.mockRejectedValue(forbiddenError);
    const fd = new FormData();
    fd.append('file', new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    const result = await uploadPdfAction({}, fd);
    expect(result.error).toBe('Forbidden');
    expect(uploadPdfMock).not.toHaveBeenCalled();
  });

  it('uploadPdfAction returns an error if no file is provided', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    const fd = new FormData();
    const result = await uploadPdfAction({}, fd);
    expect(result.error).toMatch(/No PDF/);
  });

  it('uploadPdfAction returns a success payload for a valid file', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    uploadPdfMock.mockResolvedValue(ok({
      documentId: 7,
      status: 'inserted',
      chunks: 12,
    }));
    const fd = new FormData();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x20, 0x74, 0x65, 0x73, 0x74]);
    fd.append('file', new File([pdfBytes], 'a.pdf', { type: 'application/pdf' }));
    const result = await uploadPdfAction({}, fd);
    expect(result.status).toBe('inserted');
    expect(result.chunks).toBe(12);
    expect(result.documentId).toBe(7);
  });

  it('uploadPdfAction surfaces a queued status for large async uploads', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    uploadPdfMock.mockResolvedValue(ok({
      documentId: 42,
      status: 'queued',
      chunks: 0,
    }));
    const fd = new FormData();
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x20, 0x74, 0x65, 0x73, 0x74]);
    fd.append('file', new File([pdfBytes], 'big.pdf', { type: 'application/pdf' }));
    const result = await uploadPdfAction({}, fd);
    expect(result.status).toBe('queued');
    expect(result.chunks).toBe(0);
    expect(result.documentId).toBe(42);
  });

  it('deleteDocumentAction delegates to softDeleteDocument', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    softDeleteDocumentMock.mockResolvedValue(ok(undefined));
    const result = await deleteDocumentAction(42);
    expect(softDeleteDocumentMock).toHaveBeenCalledWith({ documentId: 42, actorId: 'admin_1' });
    expect(result).toEqual({});
  });

  it('deleteDocumentAction surfaces Result errors', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    softDeleteDocumentMock.mockResolvedValue(err(new ExternalServiceError('db down')));
    const result = await deleteDocumentAction(42);
    expect(result.error).toBe('An external service is temporarily unavailable');
  });

  it('restoreDocumentAction surfaces Result errors (expired)', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    const { GoneError } = await import('@app/domain');
    restoreDocumentMock.mockResolvedValue(err(new GoneError('Restore window expired')));
    const result = await restoreDocumentAction(42);
    expect(result.error).toBe('This resource is no longer available');
  });

  it('setRoleAction rejects invalid role values', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    const result = await setRoleAction('user_1', 'superuser' as 'admin');
    expect(result.error).toMatch(/Invalid role/);
    expect(setUserRoleMock).not.toHaveBeenCalled();
  });

  it('setRoleAction forwards valid roles to setUserRole', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    setUserRoleMock.mockResolvedValue(ok({
      clerkUserId: 'user_1',
      role: 'admin',
    }) as never);
    const result = await setRoleAction('user_1', 'admin');
    expect(setUserRoleMock).toHaveBeenCalledWith({ clerkUserId: 'user_1', role: 'admin', actorId: 'admin_1' });
    expect(result).toEqual({});
  });

  it('updateTicketAction surfaces Result errors (invalid transition)', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    const { ConflictError } = await import('@app/domain');
    updateTicketMock.mockResolvedValue(err(new ConflictError('Invalid status transition')));
    const result = await updateTicketAction('TKT-1001', { status: 'closed' });
    expect(result.error).toBe('A conflict occurred');
  });

  it('recountChunksAction 403s when requireAdmin throws', async () => {
    const forbiddenError = new Error('Forbidden') as Error & { status: number };
    forbiddenError.status = 403;
    requireAdminMock.mockRejectedValue(forbiddenError);
    const result = await recountChunksAction(42);
    expect(result.error).toBe('Forbidden');
    expect(recountChunksForDocumentMock).not.toHaveBeenCalled();
  });

  it('recountChunksAction returns the count and revalidates the path for an admin', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    recountChunksForDocumentMock.mockResolvedValue(ok({ documentId: 42, count: 12 }));
    const result = await recountChunksAction(42);
    expect(result).toEqual({ count: 12 });
    expect(recountChunksForDocumentMock).toHaveBeenCalledWith(42);
    expect(revalidatePathMock).toHaveBeenCalledWith('/admin/documents');
  });

  it('recountChunksAction surfaces Result errors', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    recountChunksForDocumentMock.mockResolvedValue(err(new ExternalServiceError('db down')));
    const result = await recountChunksAction(42);
    expect(result.error).toBe('An external service is temporarily unavailable');
  });

  it('recountAllChunksAction 403s when requireAdmin throws', async () => {
    const forbiddenError = new Error('Forbidden') as Error & { status: number };
    forbiddenError.status = 403;
    requireAdminMock.mockRejectedValue(forbiddenError);
    const result = await recountAllChunksAction();
    expect(result.error).toBe('Forbidden');
    expect(recountChunksForAllDocumentsMock).not.toHaveBeenCalled();
  });

  it('recountAllChunksAction returns summary numbers and revalidates the path for an admin', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    recountChunksForAllDocumentsMock.mockResolvedValue(ok([
      { documentId: 1, count: 5 },
      { documentId: 2, count: 7 },
    ]));
    const result = await recountAllChunksAction();
    expect(result).toEqual({ documents: 2, total: 12 });
    expect(revalidatePathMock).toHaveBeenCalledWith('/admin/documents');
  });

  it('recountAllChunksAction surfaces Result errors', async () => {
    requireAdminMock.mockResolvedValue({
      user: { id: 'admin_1', email: 'a@x.com', name: 'Admin', role: 'admin' },
    });
    recountChunksForAllDocumentsMock.mockResolvedValue(err(new ExternalServiceError('nope')));
    const result = await recountAllChunksAction();
    expect(result.error).toBe('An external service is temporarily unavailable');
  });
});
