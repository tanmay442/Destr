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
import { BarList, ActivityBars } from '@/components/admin/Charts';

export const dynamic = 'force-dynamic';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 p-4 shadow-none">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
    </Card>
  );
}

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [summaryRes, auditRes, chatRes] = await Promise.all([
    comp.getAnalyticsSummary({ actorId }),
    comp.listAudit({ limit: 20, actorId }),
    comp.getChatAnalytics({ actorId, usageDays: 7 }),
  ]);
  const summary = unwrap(summaryRes);
  const audit = unwrap(auditRes);
  const chat = chatRes.ok ? chatRes.value : null;

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

      {chat && chat.total > 0 ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Chat turns" value={chat.total} />
            <MetricCard label="Deflection rate" value={pct(chat.deflectionRate)} />
            <MetricCard label="Cache hit rate" value={pct(chat.cacheHitRate)} />
            <MetricCard label="Out-of-domain rate" value={pct(chat.outOfDomainRate)} />
            <MetricCard label="Zero-result rate" value={pct(chat.zeroResultRate)} />
            <MetricCard label="Hallucination rate" value={pct(chat.hallucinationRate)} />
            <MetricCard label="Agentic retry rate" value={pct(chat.agenticRetryRate)} />
            <MetricCard label="Est. token cost" value={usd(chat.estimatedCostUsd)} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Latency</CardTitle>
                <CardDescription>Retrieve vs generate, p50 / p95 (ms).</CardDescription>
              </CardHeader>
              <CardContent>
                <BarList
                  unit="ms"
                  items={[
                    { label: 'Retrieve p50', value: chat.retrieveP50Ms },
                    { label: 'Retrieve p95', value: chat.retrieveP95Ms },
                    { label: 'Generate p50', value: chat.generateP50Ms },
                    { label: 'Generate p95', value: chat.generateP95Ms },
                    { label: 'Total p50', value: chat.totalP50Ms },
                    { label: 'Total p95', value: chat.totalP95Ms },
                  ]}
                />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Usage</CardTitle>
                <CardDescription>Chat turns over the last 7 days.</CardDescription>
              </CardHeader>
              <CardContent>
                <ActivityBars
                  buckets={chat.usageOverTime.map((d) => ({
                    label: d.day.slice(5),
                    value: d.total,
                  }))}
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Top queries</CardTitle>
                <CardDescription>Most frequent questions (QueryStats).</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.topQueries.length > 0 ? (
                  <BarList items={summary.topQueries.map((q) => ({ label: q.q, value: q.count }))} />
                ) : (
                  <p className="text-sm text-muted-foreground">No queries recorded yet.</p>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Top zero-result queries</CardTitle>
                <CardDescription>Questions that returned no matching docs.</CardDescription>
              </CardHeader>
              <CardContent>
                {chat.topZeroResultQueries.length > 0 ? (
                  <BarList
                    items={chat.topZeroResultQueries.map((q) => ({
                      label: q.q,
                      value: q.count,
                      barClassName: 'bg-foreground-subtle',
                    }))}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No zero-result queries.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <Card className="gap-0">
          <CardHeader className="gap-1">
            <CardTitle>Chat metrics</CardTitle>
            <CardDescription>
              No chat activity recorded yet. Per-turn metrics appear here once users start chatting.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Recent activity</h3>
        <AuditEventList events={audit.events} testId="analytics-recent-activity" />
      </div>
    </section>
  );
}
