import Link from 'next/link';
import { getComposition, getAppSession, TICKET_STATUSES, unwrap, parsePageParam } from '@/composition';
import { TicketOverlay, type TicketRow } from './ticket-overlay';
import { TicketsFilterForm } from './tickets-filter-form';
import { Pagination } from '@/components/admin/Pagination';
import { Badge } from '@/components/ui/badge';
import { PAGE_SIZE, statusBadgeClass } from '@/components/admin/admin-helpers';
import { Card, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

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
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [result, userList] = await Promise.all([
    comp.listTickets({
      status: status ?? undefined,
      assignee: assignee === undefined ? undefined : assignee,
      search,
      limit: PAGE_SIZE,
      offset,
      actorId,
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
    <section className="flex flex-col gap-5">
      <TicketOverlay tickets={rows} userOptions={userList.users} />
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Tickets</h2>
        <p className="text-sm text-muted-foreground">
          Review, assign, and resolve knowledge tickets. Click a ticket to view details.
        </p>
      </div>
      <TicketsFilterForm
        statuses={TICKET_STATUSES}
        users={userList.users}
        status={status}
        assignee={assignee}
        search={search}
      />
      {result.tickets.length === 0 ? (
        <Card className="border-dashed p-8 shadow-none">
          <div className="flex flex-col items-center gap-1 text-center">
            <CardTitle className="text-base">No tickets</CardTitle>
            <CardDescription>
              No tickets matched your filters. Adjust the filters to see more.
            </CardDescription>
          </div>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-strong bg-card/50">
          <Table data-testid="tickets-table" aria-label="Tickets">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Ticket</TableHead>
                <TableHead className="w-48">User</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="hidden w-40 md:table-cell">Assignee</TableHead>
                <TableHead className="hidden w-32 text-right md:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.tickets.map((t) => (
                <TableRow
                  key={t.ticketId}
                  data-testid={`tickets-row-${t.ticketId}`}
                >
                  <TableCell className="font-medium">
                    <Link
                      href={{
                        pathname: '/admin/tickets',
                        query: { ...params, ticket: t.ticketId },
                      }}
                      className="text-primary hover:underline"
                      data-testid={`tickets-open-${t.ticketId}`}
                    >
                      {t.ticketId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">
                        {(() => {
                          const looksLikeClerkId = t.userId.startsWith('user_');
                          const nameLooksPlaceholder =
                            !t.name || t.name === 'User' || t.name === 'Unknown';
                          if (
                            looksLikeClerkId &&
                            nameLooksPlaceholder &&
                            userByClerkId.has(t.userId)
                          ) {
                            return userByClerkId.get(t.userId)?.name ?? t.name;
                          }
                          return t.name;
                        })()}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
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
                        <Badge
                          variant="outline"
                          className="mt-1 w-fit border-warning/40 text-[11px] text-warning"
                        >
                          anonymous
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-52">
                    <span
                      className="block truncate text-sm text-muted-foreground"
                      title={t.issue}
                    >
                      {t.issue}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-[11px] font-medium uppercase tracking-[0.05em] ${statusBadgeClass(t.status)}`}
                    >
                      {t.status.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span
                      className="block max-w-40 truncate text-sm text-muted-foreground"
                      title={t.assignedTo ?? undefined}
                    >
                      {t.assignedTo ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right text-xs text-muted-foreground tabular-nums md:table-cell">
                    <time dateTime={t.createdAt.toISOString()} title={t.createdAt.toISOString()}>
                      {t.createdAt.toISOString().slice(0, 10)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/tickets"
        query={{ status, assignee, q: search }}
      />
    </section>
  );
}
