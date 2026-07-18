import { getComposition, getAppSession, unwrap } from '@/composition';
import { StatCard } from '@/components/admin/StatCard';
import { AuditEventList } from '@/components/admin/AuditEventList';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  DonutChart,
  BarList,
  ChartLegend,
} from '@/components/admin/Charts';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [summaryRes, auditRes] = await Promise.all([
    comp.getAnalyticsSummary({ actorId }),
    comp.listAudit({ limit: 10, actorId }),
  ]);
  const summary = unwrap(summaryRes);
  const audit = unwrap(auditRes);

  const openTickets = summary.openTicketCount;
  const resolvedTickets = Math.max(0, summary.ticketCount - openTickets);
  const hasTickets = summary.ticketCount > 0;

  const corpusItems = [
    { label: 'Chunks', value: summary.chunkCount, barClassName: 'bg-primary' },
    {
      label: 'Documents',
      value: summary.documentCount,
      barClassName: 'bg-foreground-subtle',
    },
    {
      label: 'Tickets',
      value: summary.ticketCount,
      barClassName: 'bg-foreground-faint',
    },
    {
      label: 'Users',
      value: summary.usersCount,
      barClassName: 'bg-border-strong',
    },
  ];

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-medium">Overview</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          href="/admin/documents"
          label="Documents"
          value={summary.documentCount}
          testId="admin-card-documents"
        />
        <StatCard
          href="/admin/documents"
          label="Chunks"
          value={summary.chunkCount}
          testId="admin-card-chunks"
        />
        <StatCard
          href="/admin/tickets"
          label="Tickets"
          value={summary.ticketCount}
          testId="admin-card-tickets"
        />
        <StatCard
          href="/admin/tickets"
          label="Open tickets"
          value={summary.openTicketCount}
          testId="admin-card-open-tickets"
        />
        <StatCard
          href="/admin/users"
          label="Users"
          value={summary.usersCount}
          testId="admin-card-users"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="gap-0">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Ticket resolution</CardTitle>
            <CardDescription>
              Share of support tickets still awaiting a response.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <DonutChart
              segments={[
                { label: 'Open', value: openTickets, stroke: 'stroke-primary' },
                {
                  label: 'Resolved',
                  value: resolvedTickets,
                  stroke: 'stroke-border-strong',
                },
              ]}
            >
              <span className="text-3xl font-semibold tabular-nums text-foreground">
                {hasTickets
                  ? `${Math.round((openTickets / summary.ticketCount) * 100)}%`
                  : '—'}
              </span>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {hasTickets ? 'open' : 'no tickets'}
              </span>
            </DonutChart>
            <ChartLegend
              items={[
                { label: `Open (${openTickets})`, className: 'bg-primary' },
                {
                  label: `Resolved (${resolvedTickets})`,
                  className: 'bg-border-strong',
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card className="gap-0">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Corpus composition</CardTitle>
            <CardDescription>
              Size of the knowledge base across documents, chunks and tickets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarList items={corpusItems} />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Latest audit events</h3>
        <AuditEventList events={audit.events} testId="admin-latest-audit" />
      </div>
    </section>
  );
}
