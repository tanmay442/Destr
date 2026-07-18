import Link from 'next/link';
import { getComposition, getAppSession, TICKET_STATUSES, unwrap, parsePageParam } from '@/composition';
import { TicketOverlay, type TicketRow } from './ticket-overlay';
import { TicketsFilterForm } from './tickets-filter-form';
import { Pagination } from '@/components/admin/Pagination';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

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
    <section className="flex flex-col gap-4">
      <TicketOverlay tickets={rows} userOptions={userList.users} />
      <h2 className="text-xl font-medium">Tickets</h2>
      <TicketsFilterForm
        statuses={TICKET_STATUSES}
        users={userList.users}
        status={status}
        assignee={assignee}
        search={search}
      />
      <div className="overflow-x-auto rounded border border-border-subtle">
        <Table className="w-full table-fixed text-sm" data-testid="tickets-table">
          <TableHeader className="bg-surface-elevated text-left text-xs uppercase text-muted-foreground">
            <TableRow>
              <TableHead className="w-24 px-3 py-2 text-muted-foreground">
                Ticket
              </TableHead>
              <TableHead className="w-44 px-3 py-2 text-muted-foreground">
                User
              </TableHead>
              <TableHead className="px-3 py-2 text-muted-foreground">
                Issue
              </TableHead>
              <TableHead className="w-28 px-3 py-2 text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="w-40 px-3 py-2 text-muted-foreground">
                Assignee
              </TableHead>
              <TableHead className="w-32 px-3 py-2 text-right text-muted-foreground">
                Created
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.tickets.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="px-3 py-4 text-center text-muted-foreground"
                >
                  No tickets.
                </TableCell>
              </TableRow>
            ) : (
              result.tickets.map((t) => (
                <TableRow
                  key={t.ticketId}
                  className="border-t border-border-subtle hover:bg-transparent"
                  data-testid={`tickets-row-${t.ticketId}`}
                >
                  <TableCell className="px-3 py-2 font-medium">
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
                  <TableCell className="px-3 py-2">
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
                        <Badge className="mt-1 bg-warning/10 text-[10px] text-warning">
                          (anonymous)
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md truncate px-3 py-2 text-xs">
                    {t.issue}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 py-2 text-xs">
                    <Badge className="bg-surface-elevated text-foreground">
                      {t.status}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="truncate px-3 py-2 text-xs"
                    title={t.assignedTo ?? undefined}
                  >
                    {t.assignedTo ?? '—'}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground"
                    title={t.createdAt.toISOString()}
                  >
                    {t.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Pagination
        page={page}
        totalPages={totalPages}
        total={result.total}
        pathname="/admin/tickets"
        query={{ status, assignee, q: search }}
        linkClassName="rounded-md border border-border px-3 py-1 text-muted-foreground hover:bg-card hover:text-foreground"
      />
    </section>
  );
}
