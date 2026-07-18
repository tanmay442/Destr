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
  ActivityBars,
  ChartLegend,
} from '@/components/admin/Charts';

export const dynamic = 'force-dynamic';

function bucketByDay(
  events: { at: Date }[],
  days = 7,
): { label: string; value: number }[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

  const buckets = Array.from({ length: days }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return {
      label: date.toLocaleDateString('en-US', { weekday: 'short' }),
      value: 0,
    };
  });

  for (const event of events) {
    const date = new Date(event.at);
    date.setHours(0, 0, 0, 0);
    const index = Math.floor((date.getTime() - start.getTime()) / 86_400_000);
    if (index >= 0 && index < days) {
      buckets[index].value += 1;
    }
  }

  return buckets;
}

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [summaryRes, auditRes] = await Promise.all([
    comp.getAnalyticsSummary({ actorId }),
    comp.listAudit({ limit: 20, actorId }),
  ]);
  const summary = unwrap(summaryRes);
  const audit = unwrap(auditRes);

  const documentEvents = audit.events.filter((e) => e.kind === 'document').length;
  const ticketEvents = audit.events.filter((e) => e.kind === 'ticket').length;
  const hasActivity = documentEvents + ticketEvents > 0;

  const timeline = bucketByDay(audit.events, 7);

  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-medium">Analytics</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Documents" value={summary.documentCount} />
        <StatCard label="Chunks" value={summary.chunkCount} />
        <StatCard label="Tickets" value={summary.ticketCount} />
        <StatCard label="Open tickets" value={summary.openTicketCount} />
        <StatCard label="Users" value={summary.usersCount} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="gap-0">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Activity by type</CardTitle>
            <CardDescription>
              Recent administrative actions split by resource.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            <DonutChart
              segments={[
                {
                  label: 'Document',
                  value: documentEvents,
                  stroke: 'stroke-primary',
                },
                {
                  label: 'Ticket',
                  value: ticketEvents,
                  stroke: 'stroke-foreground-subtle',
                },
              ]}
            >
              <span className="text-3xl font-semibold tabular-nums text-foreground">
                {documentEvents + ticketEvents}
              </span>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {hasActivity ? 'events' : 'no activity'}
              </span>
            </DonutChart>
            <ChartLegend
              items={[
                { label: `Documents (${documentEvents})`, className: 'bg-primary' },
                {
                  label: `Tickets (${ticketEvents})`,
                  className: 'bg-foreground-subtle',
                },
              ]}
            />
          </CardContent>
        </Card>

        <Card className="gap-0">
          <CardHeader className="gap-1 pb-4">
            <CardTitle>Activity timeline</CardTitle>
            <CardDescription>
              Administrative actions over the last 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityBars buckets={timeline} />
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Recent activity</h3>
        <AuditEventList events={audit.events} testId="analytics-recent-activity" />
      </div>
    </section>
  );
}
