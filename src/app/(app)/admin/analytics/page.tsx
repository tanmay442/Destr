import { getComposition, getAppSession, unwrap } from '@/composition';
import { AuditEventList } from '@/components/admin/AuditEventList';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { BarList, ActivityBars, LineChart } from '@/components/admin/Charts';
import type { AnalyticsTrendPoint } from '@app/application';
import type { ModeComparison } from '@app/domain';

export const dynamic = 'force-dynamic';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const num = (n: number) => n.toLocaleString();
const ms = (n: number) => `${Math.round(n).toLocaleString()} ms`;
const MODE_LABELS: Record<ModeComparison['mode'], string> = {
  agentic: 'Agentic',
  vector: 'Vector',
};

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 p-4 shadow-none">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground">{value}</span>
    </Card>
  );
}

interface WeeklyPoint {
  label: string;
  total: number;
  hallucinationRate: number;
  outOfDomainRate: number;
  cacheHitRate: number;
  selfServeSuccessRate: number;
  avgMaxSimilarity: number;
  totalP50Ms: number;
  totalP95Ms: number;
}

function toWeekly(points: AnalyticsTrendPoint[], maxWeeks = 12): WeeklyPoint[] {
  const weeks: WeeklyPoint[] = [];
  for (let i = 0; i < points.length; i += 7) {
    const group = points.slice(i, i + 7);
    const total = group.reduce((s, p) => s + p.total, 0);
    const weight = total > 0 ? total : group.length;
    const wAvg = (pick: (p: AnalyticsTrendPoint) => number) =>
      total > 0
        ? group.reduce((s, p) => s + pick(p) * p.total, 0) / total
        : group.reduce((s, p) => s + pick(p), 0) / weight;
    weeks.push({
      label: (group[group.length - 1]?.day ?? '').slice(5),
      total,
      hallucinationRate: wAvg((p) => p.hallucinationRate),
      outOfDomainRate: wAvg((p) => p.outOfDomainRate),
      cacheHitRate: wAvg((p) => p.cacheHitRate),
      selfServeSuccessRate: wAvg((p) => p.selfServeSuccessRate),
      avgMaxSimilarity: wAvg((p) => p.avgMaxSimilarity),
      totalP50Ms: wAvg((p) => p.totalP50Ms),
      totalP95Ms: wAvg((p) => p.totalP95Ms),
    });
  }
  return weeks.slice(-maxWeeks);
}

function truncate(value: string, max = 14) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function ModeComparisonCard({ mode }: { mode: ModeComparison }) {
  const buckets = mode.queryLengthBuckets;
  const bucketTotal = Math.max(1, buckets.short + buckets.medium + buckets.long);
  return (
    <Card className="gap-0" data-testid={`analytics-mode-${mode.mode}`}>
      <CardHeader className="gap-1 pb-4">
        <CardTitle>{MODE_LABELS[mode.mode]}</CardTitle>
        <CardDescription>{num(mode.total)} turns</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Avg tokens/query</dt>
            <dd className="font-medium tabular-nums text-foreground">{num(Math.round(mode.avgTokensPerQuery))}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Avg similarity</dt>
            <dd className="font-medium tabular-nums text-foreground">{mode.avgMaxSimilarity.toFixed(3)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Ticket rate</dt>
            <dd className="font-medium tabular-nums text-foreground">{pct(mode.ticketRate)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Hallucination rate</dt>
            <dd className="font-medium tabular-nums text-foreground">{pct(mode.hallucinationRate)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p50</dt>
            <dd className="font-medium tabular-nums text-foreground">{ms(mode.totalP50Ms)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p95</dt>
            <dd className="font-medium tabular-nums text-foreground">{ms(mode.totalP95Ms)}</dd>
          </div>
        </dl>
        <Separator />
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Query length</span>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div className="bg-primary" style={{ width: `${(buckets.short / bucketTotal) * 100}%` }} />
            <div className="bg-foreground-subtle" style={{ width: `${(buckets.medium / bucketTotal) * 100}%` }} />
            <div className="bg-foreground-faint" style={{ width: `${(buckets.long / bucketTotal) * 100}%` }} />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>Short {num(buckets.short)}</span>
            <span>Medium {num(buckets.medium)}</span>
            <span>Long {num(buckets.long)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [auditRes, chatRes, trendsRes, topicsRes, summaryRes] = await Promise.all([
    comp.listAudit({ limit: 20, actorId }),
    comp.getChatAnalytics({ actorId, usageDays: 7 }),
    comp.getAnalyticsTrends({ actorId }),
    comp.getTopicCoverage({ actorId }),
    comp.getAnalyticsSummary({ actorId }),
  ]);
  const audit = unwrap(auditRes);
  const chat = chatRes.ok ? chatRes.value : null;
  const trends = trendsRes.ok ? trendsRes.value : null;
  const topics = topicsRes.ok ? topicsRes.value : null;
  const summary = summaryRes.ok ? summaryRes.value : null;

  const weekly = trends ? toWeekly(trends.points) : [];
  const hasTrends = weekly.some((w) => w.total > 0);
  const series = (pick: (w: WeeklyPoint) => number) =>
    weekly.map((w) => ({ label: w.label, value: pick(w) }));

  const activeModes = chat ? chat.modeComparison.filter((m) => m.total > 0) : [];
  const hasChat = chat != null && chat.total > 0;

  return (
    <section className="flex flex-col gap-10">
      <h2 className="text-xl font-medium">Analytics</h2>

      <section className="flex flex-col gap-4" data-testid="analytics-quality">
        <h3 className="text-lg font-medium">Quality</h3>

        {hasChat ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Chat turns" value={num(chat.total)} />
            <MetricCard label="Hallucination rate" value={pct(chat.hallucinationRate)} />
            <MetricCard label="Out-of-domain rate" value={pct(chat.outOfDomainRate)} />
            <MetricCard label="Cache hit rate" value={pct(chat.cacheHitRate)} />
            <MetricCard label="Self-serve success" value={pct(chat.selfServeSuccessRate)} />
          </div>
        ) : null}

        {hasTrends ? (
          <div
            className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
            data-testid="analytics-quality-trends"
          >
            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Hallucination rate</CardTitle>
                <CardDescription>Weekly, threshold 5%.</CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={series((w) => w.hallucinationRate)}
                  percentage
                  threshold={0.05}
                />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Out-of-domain rate</CardTitle>
                <CardDescription>Weekly coverage gap.</CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart data={series((w) => w.outOfDomainRate)} percentage />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Avg similarity</CardTitle>
                <CardDescription>Best-match cosine, weekly.</CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart
                  data={series((w) => w.avgMaxSimilarity)}
                  formatValue={(v) => v.toFixed(3)}
                />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Cache hit rate</CardTitle>
                <CardDescription>Weekly cache warming.</CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart data={series((w) => w.cacheHitRate)} percentage />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Self-serve success</CardTitle>
                <CardDescription>Resolved without a ticket or gap.</CardDescription>
              </CardHeader>
              <CardContent>
                <LineChart data={series((w) => w.selfServeSuccessRate)} percentage />
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1 pb-4">
                <CardTitle>Total latency</CardTitle>
                <CardDescription>End-to-end p50 / p95, weekly.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">p50</span>
                  <LineChart data={series((w) => w.totalP50Ms)} valueSuffix=" ms" height={72} />
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">p95</span>
                  <LineChart
                    data={series((w) => w.totalP95Ms)}
                    valueSuffix=" ms"
                    height={72}
                    className="text-foreground-subtle"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="gap-0">
            <CardHeader className="gap-1">
              <CardTitle>Trends</CardTitle>
              <CardDescription>
                No trend data yet. Weekly quality charts appear once the daily rollup has collected
                history.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-4" data-testid="analytics-performance">
        <h3 className="text-lg font-medium">Performance</h3>

        {hasChat ? (
          <>
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
                  <CardTitle>Cache-buster queries</CardTitle>
                  <CardDescription>Repeatedly miss cache — candidates for new docs.</CardDescription>
                </CardHeader>
                <CardContent>
                  {chat.cacheBusterQueries.length > 0 ? (
                    <BarList
                      unit=" misses"
                      items={chat.cacheBusterQueries.map((q) => ({
                        label: q.query,
                        value: q.misses,
                        barClassName: 'bg-foreground-subtle',
                      }))}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">No repeat cache misses.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-col gap-2" data-testid="analytics-mode-comparison">
              <h4 className="text-sm font-medium text-muted-foreground">Mode comparison</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Agentic retry rate" value={pct(chat.agenticRetryRate)} />
              </div>
              {activeModes.length >= 2 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {activeModes.map((mode) => (
                    <ModeComparisonCard key={mode.mode} mode={mode} />
                  ))}
                </div>
              ) : (
                <Card className="gap-0">
                  <CardHeader className="gap-1">
                    <CardTitle>Comparison unavailable</CardTitle>
                    <CardDescription>
                      Only {activeModes.length === 1 ? MODE_LABELS[activeModes[0]!.mode] : 'one'} mode
                      has traffic. Set the retrieval mode rollout below 100% to collect A/B data.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          </>
        ) : (
          <Card className="gap-0">
            <CardHeader className="gap-1">
              <CardTitle>Performance</CardTitle>
              <CardDescription>No chat activity recorded yet.</CardDescription>
            </CardHeader>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-4" data-testid="analytics-behavior">
        <h3 className="text-lg font-medium">Behavior</h3>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="gap-0" data-testid="analytics-topic-coverage">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Topic coverage</CardTitle>
              <CardDescription>Coverage and ticket rate per seeded topic.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {topics && topics.topics.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Topic</TableHead>
                      <TableHead className="text-right">Queries</TableHead>
                      <TableHead className="text-right">Coverage</TableHead>
                      <TableHead className="text-right">Ticket rate</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topics.topics.map((t) => (
                      <TableRow key={t.topic}>
                        <TableCell className="font-medium text-foreground">{t.topic}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(t.queries)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {t.queries > 0 ? pct(1 - t.oodRate) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {t.queries > 0 ? pct(t.ticketRate) : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          {t.frustrated ? (
                            <Badge variant="destructive">Frustrated</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No topic activity yet.</p>
              )}
              {topics && topics.unmatched > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {num(topics.unmatched)} queries matched no seeded topic.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-0" data-testid="analytics-stuck-sessions">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Stuck sessions</CardTitle>
              <CardDescription>
                Sessions with repeated turns and no resolution.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {chat ? num(chat.stuckSessions.count) : '0'}
              </span>
              {chat && chat.stuckSessions.samples.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Turns</TableHead>
                      <TableHead className="text-right">Last activity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {chat.stuckSessions.samples.map((s) => (
                      <TableRow key={`${s.userId}-${s.sessionNo}`}>
                        <TableCell className="font-mono text-xs text-foreground">
                          {truncate(s.userId)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{num(s.turns)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {new Date(s.lastActivity).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No stuck sessions detected.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="gap-0">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Top queries</CardTitle>
              <CardDescription>Most frequent questions.</CardDescription>
            </CardHeader>
            <CardContent>
              {summary && summary.topQueries.length > 0 ? (
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
              {chat && chat.topZeroResultQueries.length > 0 ? (
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

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card className="gap-0">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Usage</CardTitle>
              <CardDescription>Chat turns over the last 7 days.</CardDescription>
            </CardHeader>
            <CardContent>
              {chat ? (
                <ActivityBars
                  buckets={chat.usageOverTime.map((d) => ({
                    label: d.day.slice(5),
                    value: d.total,
                  }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
              )}
            </CardContent>
          </Card>

          <Card className="gap-0">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Token cost</CardTitle>
              <CardDescription>Estimated spend and token throughput.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MetricCard label="Est. cost" value={chat ? usd(chat.estimatedCostUsd) : usd(0)} />
              <MetricCard label="Tokens in" value={chat ? num(chat.tokensIn) : '0'} />
              <MetricCard label="Tokens out" value={chat ? num(chat.tokensOut) : '0'} />
            </CardContent>
          </Card>
        </div>
      </section>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-medium">Recent activity</h3>
        <AuditEventList events={audit.events} testId="analytics-recent-activity" />
      </div>
    </section>
  );
}
