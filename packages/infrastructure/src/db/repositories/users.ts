import { and, asc, desc, eq, gt, ilike, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import { users } from '../schema';
import type { CursorContext, ListCursorCodec, UserListCursor, UserRepository, UserRow } from '@app/domain';
import { ConflictError, MAX_LEGACY_LIST_OFFSET, MAX_LIST_LIMIT, ValidationError } from '@app/domain';
import { invalidateRoleCache } from '../../auth/role-cache';
import type { Client } from './shared';
import { encodeRepositoryCursor, escapeLikePattern, requiredAnd, requiredOr, whereAnd } from './shared';

export const userRepo = {
  async upsertFromClerk(input: {
    clerkUserId: string;
    email: string;
    name?: string | null;
    imageUrl?: string | null;
    role: 'admin' | 'user';
    emailVerified?: boolean | undefined;
  }, client: Client = db): Promise<UserRow> {
    const run = async (tx: Client): Promise<UserRow> => {
      const [row] = await tx
        .insert(users)
        .values({
          clerkUserId: input.clerkUserId,
          email: input.email,
          name: input.name,
          imageUrl: input.imageUrl,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: users.clerkUserId,
          set: {
            email: input.email,
            role: input.role,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
          },
        })
        .returning();
      if (!row) throw new Error('Failed to upsert user');
      return row as UserRow;
    };

    try {
      return await run(client);
    } catch (err) {
      const wrapped = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      const pgErr = wrapped.code === '23505' ? wrapped : wrapped.cause;
      if (pgErr?.code === '23505' && pgErr.constraint === 'users_email_unique') {
        throw new ConflictError(
          'This email address is already associated with another account; automatic identity rebinding is disabled.',
        );
      }
      throw err;
    }
  },
  async findByClerkId(clerkUserId: string, client: Client = db): Promise<UserRow | null> {
    const row = await client.query.users.findFirst({ where: eq(users.clerkUserId, clerkUserId) });
    return (row as UserRow | undefined) ?? null;
  },
  async findByIds(clerkUserIds: string[], client: Client = db): Promise<UserRow[]> {
    if (clerkUserIds.length === 0) return [];
    const rows = await client.query.users.findMany({
      where: (u, { inArray }) => inArray(u.clerkUserId, clerkUserIds),
    });
    return rows as UserRow[];
  },
  async setRole(clerkUserId: string, role: 'admin' | 'user', client: Client = db): Promise<UserRow | null> {
    const [row] = await client.update(users).set({ role }).where(eq(users.clerkUserId, clerkUserId)).returning();
    invalidateRoleCache(clerkUserId);
    return (row as UserRow | null) ?? null;
  },
  async setRoleIfCurrent(
    clerkUserId: string,
    expectedRole: 'admin' | 'user',
    role: 'admin' | 'user',
    client: Client = db,
  ): Promise<boolean> {
    const [row] = await client
      .update(users)
      .set({ role })
      .where(and(eq(users.clerkUserId, clerkUserId), eq(users.role, expectedRole)))
      .returning({ clerkUserId: users.clerkUserId });
    if (row) invalidateRoleCache(clerkUserId);
    return row !== undefined;
  },
  async touchLastSeen(clerkUserId: string, client: Client = db): Promise<void> {
    await client.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.clerkUserId, clerkUserId));
  },
  async list(opts: {
    search?: string | undefined;
    limit: number;
    offset?: number | undefined;
    cursor?: UserListCursor | undefined;
    before?: UserListCursor | undefined;
    cursorCodec?: ListCursorCodec | undefined;
    cursorContext?: CursorContext | undefined;
  }, client: Client = db): Promise<{
    rows: UserRow[];
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }> {
    if (opts.cursor !== undefined && opts.before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const search = opts.search?.trim();
    const filterParts: SQL[] = [];
    if (search) {
      filterParts.push(
        requiredOr(
          ilike(users.email, `%${escapeLikePattern(search)}%`),
          ilike(users.name, `%${escapeLikePattern(search)}%`),
        ),
      );
    }
    const filter = whereAnd(filterParts);
    const pageParts = [...filterParts];
    const isBackward = opts.before !== undefined;
    const position = opts.cursor ?? opts.before;
    if (position !== undefined) {
      pageParts.push(
        isBackward
          ? requiredOr(
              lt(users.createdAt, position.sortAt),
              requiredAnd(eq(users.createdAt, position.sortAt), lt(users.clerkUserId, position.clerkUserId)),
            )
          : requiredOr(
              gt(users.createdAt, position.sortAt),
              requiredAnd(eq(users.createdAt, position.sortAt), gt(users.clerkUserId, position.clerkUserId)),
            ),
      );
    }
    const pageFilter = whereAnd(pageParts);
    const limit = Math.min(Math.max(opts.limit, 1), MAX_LIST_LIMIT);
    const query = client
      .select()
      .from(users)
      .where(pageFilter)
      .orderBy(
        ...(isBackward
          ? [desc(users.createdAt), desc(users.clerkUserId)]
          : [asc(users.createdAt), asc(users.clerkUserId)]),
      )
      .limit(limit + 1);
    const queriedRows = !isBackward && opts.cursor === undefined && opts.offset !== undefined
      ? await query.offset(Math.min(Math.max(opts.offset, 0), MAX_LEGACY_LIST_OFFSET))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = (isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit)) as UserRow[];
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(filter))[0]?.count ?? 0;
    const firstRow = pageRows[0];
    const lastRow = pageRows[pageRows.length - 1];
    const hasNext = isBackward ? pageRows.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (opts.cursor !== undefined || (opts.offset ?? 0) > 0) && pageRows.length > 0;
    return {
      rows: pageRows,
      total,
      nextCursor: hasNext && lastRow
        ? encodeRepositoryCursor(
            { kind: 'users', sortAt: lastRow.createdAt, clerkUserId: lastRow.clerkUserId, total },
            opts.cursorCodec,
            opts.cursorContext,
          )
        : null,
      previousCursor: hasPrevious && firstRow
        ? encodeRepositoryCursor(
            { kind: 'users', sortAt: firstRow.createdAt, clerkUserId: firstRow.clerkUserId, total },
            opts.cursorCodec,
            opts.cursorContext,
          )
        : null,
    };
  },
  async countAll(client: Client = db): Promise<number> {
    const [row] = await client.select({ count: sql<number>`count(*)::int` }).from(users);
    return row?.count ?? 0;
  },
  async countAdmins(client: Client = db): Promise<number> {
    const [row] = await client
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.role, 'admin'));
    return row?.count ?? 0;
  },
  async countAdminsForUpdate(client: Client = db): Promise<number> {
    const result = await client.execute(sql`
      select count(*)::int as count
      from (select 1 from ${users} where ${users.role} = 'admin' for update) locked
    `);
    const rows = (result as unknown as { rows?: Array<{ count: number }> }).rows ?? [];
    return Number(rows[0]?.count ?? 0);
  },
};

export function createUserRepo(client: Client = db): UserRepository {
  return {
    upsertFromClerk: (input) => userRepo.upsertFromClerk(input, client),
    findByClerkId: (clerkUserId) => userRepo.findByClerkId(clerkUserId, client),
    findByIds: (clerkUserIds) => userRepo.findByIds(clerkUserIds, client),
    setRole: (clerkUserId, role) => userRepo.setRole(clerkUserId, role, client),
    touchLastSeen: (clerkUserId) => userRepo.touchLastSeen(clerkUserId, client),
    list: (opts) => userRepo.list(opts, client),
    countAll: () => userRepo.countAll(client),
    countAdmins: () => userRepo.countAdmins(client),
    countAdminsForUpdate: () => userRepo.countAdminsForUpdate(client),
  };
}
