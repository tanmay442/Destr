import type { CursorContext, ListCursorCodec } from '../pagination';
import type { AuditListCursor, TicketListCursor, UserListCursor } from './cursors';
import type { CursorPageInfo } from './cursors';
import type { ChatEventRange, TicketResponseTimes } from './chat';

export interface TicketRow {
  id: number;
  ticketId: string;
  userId: string;
  name: string;
  email: string;
  issue: string;
  status: 'created' | 'in_progress' | 'closed';
  createdAt: Date;
  assignedTo: string | null;
  notes: string | null;
}

export interface TicketRepository {
  findByTicketId(ticketId: string): Promise<TicketRow | null>;
  findByTicketIdForUpdate?(ticketId: string): Promise<TicketRow | null>;
  list(
    opts: {
      status?: 'created' | 'in_progress' | 'closed' | undefined;
      assignee?: string | null | undefined;
      search?: string | undefined;
      limit: number;
      offset?: number | undefined;
      cursor?: TicketListCursor | undefined;
      before?: TicketListCursor | undefined;
      cursorCodec?: ListCursorCodec | undefined;
      cursorContext?: CursorContext | undefined;
    },
  ): Promise<{ rows: TicketRow[]; total: number } & CursorPageInfo>;
  latest(): Promise<{ id: number; ticketId: string } | null>;
  insert(input: {
    ticketId: string;
    userId: string;
    name: string;
    email: string;
    issue: string;
  }): Promise<TicketRow>;
  update(
    ticketId: string,
    patch: Partial<Pick<TicketRow, 'status' | 'assignedTo' | 'notes'>>,
  ): Promise<TicketRow | null>;
  countAll(): Promise<number>;
  countOpen(): Promise<number>;
  getTicketResponseTimes(range?: ChatEventRange): Promise<TicketResponseTimes>;
}

export interface UserRow {
  clerkUserId: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  role: 'admin' | 'user';
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface UserRepository {
  upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
    emailVerified?: boolean | undefined;
  }): Promise<UserRow>;
  findByClerkId(clerkUserId: string): Promise<UserRow | null>;
  findByIds(clerkUserIds: string[]): Promise<UserRow[]>;
  setRole(clerkUserId: string, role: 'admin' | 'user'): Promise<UserRow | null>;
  /** Change a role only when the row still has the expected role. */
  setRoleIfCurrent?(
    clerkUserId: string,
    expectedRole: 'admin' | 'user',
    role: 'admin' | 'user',
  ): Promise<boolean>;
  touchLastSeen(clerkUserId: string): Promise<void>;
  list(opts: {
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: UserListCursor | undefined;
    before?: UserListCursor | undefined;
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
  }): Promise<{ rows: UserRow[]; total: number } & CursorPageInfo>;
  countAll(): Promise<number>;
  countAdmins(): Promise<number>;
  /** Count admin rows while holding row locks so concurrent demotions serialize on the same count. */
  countAdminsForUpdate(): Promise<number>;
}

type DocumentAuditAction = 'upload' | 'replace' | 'delete' | 'restore';
type TicketAuditAction =
  | 'create'
  | 'assign'
  | 'status_change'
  | 'note'
  | 'impersonation'
  | 'role_change';

export type AuditKind = 'document' | 'ticket' | 'user' | 'settings' | 'chat';

export interface AuditEventInput {
  kind: AuditKind;
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: number;
  kind: AuditKind;
  action: string;
  actorId: string;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  at: Date;
}

export interface AuditListFilter {
  kind?: AuditKind | undefined;
  action?: string | undefined;
  actorId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  documentId?: number | undefined;
  ticketId?: string | undefined;
  limit: number;
  offset?: number | undefined;
  cursor?: AuditListCursor | undefined;
  before?: AuditListCursor | undefined;
  cursorCodec?: ListCursorCodec | undefined;
  cursorContext?: CursorContext | undefined;
}

export interface AuditLog {
  /** Generic write into the single `audit_events` table. */
  logEvent(input: AuditEventInput): Promise<void>;
  logDocumentEvent(input: {
    action: DocumentAuditAction;
    documentId: number;
    actorId: string;
  }): Promise<void>;
  logTicketEvent(input: {
    action: TicketAuditAction;
    ticketId: string;
    actorId: string;
  }): Promise<void>;
  /** Record a dedicated user/role audit entry (separate from the ticket trail). */
  logUserEvent(input: {
    targetUserId: string;
    actorId: string;
    fromRole: 'admin' | 'user';
    toRole: 'admin' | 'user';
  }): Promise<void>;
  /** Persist a dead-letter record whose primary write failed, for later replay. */
  recordDeadLetter(input: {
    kind: AuditKind | 'ingest' | 'chat_event';
    payload: unknown;
    error: string;
  }): Promise<void>;
  list(input: AuditListFilter): Promise<{
    events: AuditEventRecord[];
    total: number;
  } & CursorPageInfo>;
}
