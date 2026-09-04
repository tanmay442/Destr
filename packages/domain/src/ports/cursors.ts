import type { AdminListCursor } from '../pagination';

export type DocumentListCursor = Extract<AdminListCursor, { kind: 'documents' }>;
export type TicketListCursor = Extract<AdminListCursor, { kind: 'tickets' }>;
export type UserListCursor = Extract<AdminListCursor, { kind: 'users' }>;
export type AuditListCursor = Extract<AdminListCursor, { kind: 'audit' }>;

export interface CursorPageInfo {
  nextCursor: string | null;
  previousCursor: string | null;
}
