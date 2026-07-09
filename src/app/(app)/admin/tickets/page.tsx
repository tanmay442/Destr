import Link from 'next/link';
import { getComposition, TICKET_STATUSES, unwrap, parsePageParam } from '@/composition';
import { TicketOverlay, type TicketRow } from './ticket-overlay';
import { Pagination } from '@/components/admin/Pagination';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    assignee?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;
  const status = TICKET_STATUSES.find((s) => s === params.status);
  const assignee = params.assignee?.trim() || undefined;
  const search = params.q?.trim() || undefined;
  const page = parsePageParam(params.page);
  const offset = (page - 1) * PAGE_SIZE;
  const comp = getComposition();
  const [result, userList] = await Promise.all([
    comp.listTickets({
      status: status ?? undefined,
      assignee: assignee === undefined ? undefined : assignee,
      search,
      limit: PAGE_SIZE,
      offset,
    }),
    comp.listUsers({ limit: 100 }),
  ]).then(([t, u]) => [unwrap(t), unwrap(u)] as const);
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const userByClerkId = new Map<
    string,
    { name: string | null; email: string }
  >();
  for (const u of userList.users) {
    userByClerkId.set(u.clerkUserId, {
      name: u.name,
      email: u.email,
    });
  }
  const isPlaceholderEmail = (e: string) =>
    e === '' || e === 'user@example.com' || e.endsWith('@example.com');
  const rows: TicketRow[] = result.tickets.map((t) => ({
    ticketId: t.ticketId,
    userId: t.userId,
    name: t.name,
    email: t.email,
    issue: t.issue,
    status: t.status,
    assignedTo: t.assignedTo,
    notes: t.notes,
  }));
  return (
    <section className="flex flex-col gap-4">
      <TicketOverlay tickets={rows} userOptions={userList.users} />
      <h2 className="text-xl font-medium">Tickets</h2>
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-4"
        method="get"
        aria-label="Filter tickets"
      >
        <label className="sr-only" htmlFor="tickets-filter-status">
          Status
        </label>
        <select
          id="tickets-filter-status"
          name="status"
          defaultValue={status ?? ''}
          className="rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          data-testid="tickets-filter-status"
        >
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="tickets-filter-assignee">
          Assignee
        </label>
        <select
          id="tickets-filter-assignee"
          name="assignee"
          defaultValue={assignee ?? ''}
          className="rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          data-testid="tickets-filter-assignee"
        >
          <option value="">Any assignee</option>
          {userList.users.map((u) => (
            <option key={u.clerkUserId} value={u.clerkUserId}>
              {u.name ?? u.email}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="tickets-search">
          Search issue
        </label>
        <input
          id="tickets-search"
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search issue…"
          className="rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          data-testid="tickets-search"
        />
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]"
        >
          Apply
        </button>
      </form>
      <div className="overflow-x-auto rounded border border-[var(--border-subtle)]">
        <table
          className="w-full table-fixed text-sm"
          data-testid="tickets-table"
        >
          <thead className="bg-[var(--surface-elevated)] text-left text-xs uppercase text-[var(--foreground-muted)]">
            <tr>
              <th className="w-24 px-3 py-2">Ticket</th>
              <th className="w-44 px-3 py-2">User</th>
              <th className="px-3 py-2">Issue</th>
              <th className="w-28 px-3 py-2">Status</th>
              <th className="w-40 px-3 py-2">Assignee</th>
              <th className="w-32 px-3 py-2 text-right">Created</th>
            </tr>
          </thead>
          <tbody>
            {result.tickets.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-4 text-center text-[var(--foreground-muted)]"
                >
                  No tickets.
                </td>
              </tr>
            ) : (
              result.tickets.map((t) => (
                <tr
                  key={t.ticketId}
                  className="border-t border-[var(--border-subtle)]"
                  data-testid={`tickets-row-${t.ticketId}`}
                >
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={{
                        pathname: '/admin/tickets',
                        query: { ...params, ticket: t.ticketId },
                      }}
                      className="text-[var(--accent)] hover:underline"
                      data-testid={`tickets-open-${t.ticketId}`}
                    >
                      {t.ticketId}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">
                        {(() => {
                          const looksLikeClerkId = t.userId.startsWith('user_');
                          const nameLooksPlaceholder =
                            !t.name || t.name === 'User' || t.name === 'Unknown';
                          if (
                            looksLikeClerkId &&
                            nameLooksPlaceholder &&
                            userByClerkId.has(t.userId)
                          ) {
                            return (
                              userByClerkId.get(t.userId)?.name ??
                              t.name
                            );
                          }
                          return t.name;
                        })()}
                      </span>
                      <span className="truncate text-xs text-[var(--foreground-muted)]">
                        {(() => {
                          const looksLikeClerkId = t.userId.startsWith('user_');
                          if (
                            looksLikeClerkId &&
                            isPlaceholderEmail(t.email) &&
                            userByClerkId.has(t.userId)
                          ) {
                            return userByClerkId.get(t.userId)?.email ?? t.email;
                          }
                          return t.email;
                        })()}
                      </span>
                      {t.userId === 'anonymous' ? (
                        <span className="mt-1 rounded bg-[var(--warning)]/10 px-1 py-0.5 text-[10px] text-[var(--warning)]">
                          (anonymous)
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="max-w-md truncate px-3 py-2 text-xs">
                    {t.issue}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    <span className="rounded bg-[var(--surface-elevated)] px-2 py-0.5 text-[var(--foreground)]">
                      {t.status}
                    </span>
                  </td>
                  <td className="truncate px-3 py-2 text-xs" title={t.assignedTo ?? undefined}>
                    {t.assignedTo ?? '—'}
                  </td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-right text-xs text-zinc-500"
                    title={t.createdAt.toISOString()}
                  >
                    {t.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/tickets"
        query={{ status, assignee, q: search }}
        linkClassName="rounded border border-[var(--border)] px-3 py-1 text-[var(--foreground-muted)] hover:bg-[var(--surface-elevated)] hover:text-[var(--foreground)]"
      />
    </section>
  );
}
