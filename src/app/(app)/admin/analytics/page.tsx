import { getComposition, unwrap } from '@/composition';
import { StatCard } from '@/components/admin/StatCard';
import { AuditEventList } from '@/components/admin/AuditEventList';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const comp = getComposition();
  const summary = unwrap(await comp.getAnalyticsSummary());
  const audit = unwrap(await comp.listAudit({ limit: 20 }));
  return (
    <section className="flex flex-col gap-6">
      <h2 className="text-xl font-medium">Analytics</h2>
      <p className="text-xs text-muted-foreground">
        The &quot;top queries&quot; counter is in-process; values reset on cold
        start and only count queries made since the most recent deploy.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Documents" value={summary.documentCount} />
        <StatCard label="Chunks" value={summary.chunkCount} />
        <StatCard label="Tickets" value={summary.ticketCount} />
        <StatCard label="Open tickets" value={summary.openTicketCount} />
        <StatCard label="Users" value={summary.usersCount} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Top queries</h3>
        {summary.topQueries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queries yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border">
            <Table data-testid="analytics-top-queries" aria-label="Top queries">
              <TableHeader className="bg-secondary text-muted-foreground">
                <TableRow>
                  <TableHead className="px-3 py-2 text-left text-xs uppercase">
                    Query
                  </TableHead>
                  <TableHead className="px-3 py-2 text-right text-xs uppercase">
                    Count
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.topQueries.map((q) => (
                  <TableRow
                    key={q.q}
                    className="border-border-subtle hover:bg-secondary/40"
                  >
                    <TableCell className="px-3 py-2 text-foreground">
                      {q.q}
                    </TableCell>
                    <TableCell className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                      {q.count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Recent activity</h3>
        <AuditEventList events={audit.events} testId="analytics-recent-activity" />
      </div>
    </section>
  );
}
