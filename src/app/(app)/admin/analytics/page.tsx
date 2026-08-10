import { getComposition, getAppSession } from '@/composition';
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
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { BarList, ActivityBars, LineChart } from '@/components/admin/Charts';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format-duration';
import type { ReactNode } from 'react';
import { ThumbsUp, ThumbsDown, MessageSquare, Activity, Ticket, Inbox, BarChart3, Gauge, Sparkles } from 'lucide-react';
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

function MetricCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
}) {
  const valueClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'destructive'
          ? 'text-destructive'
          : 'text-foreground';
  return (
    <Card className="gap-2 p-4 shadow-none">
      <Eyebrow className="flex items-center gap-1.5">
        {icon ? <span aria-hidden>{icon}</span> : null}
        {label}
      </Eyebrow>
      <span className={cn('text-2xl font-semibold tabular-nums', valueClass)}>
        {value}
      </span>
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
  ticketsCreated: number;
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
      ticketsCreated: group.reduce((s, p) => s + p.ticketsCreated, 0),
    });
  }
  return weeks.slice(-maxWeeks);
}

function padUsage(rows: { day: string; total: number }[], days: number) {
  const map = new Map(rows.map((r) => [r.day, r.total]));
  const out: { label: string; value: number }[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ label: key.slice(5), value: map.get(key) ?? 0 });
  }
  return out;
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
            <dd className="font-medium text-foreground tabular-nums">
              {num(Math.round(mode.avgTokensPerQuery))}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Avg similarity</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {mode.avgMaxSimilarity.toFixed(3)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Ticket rate</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {pct(mode.ticketRate)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Hallucination rate</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {pct(mode.hallucinationRate)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p50</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {ms(mode.totalP50Ms)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p95</dt>
            <dd className="font-medium text-foreground tabular-nums">
              {ms(mode.totalP95Ms)}
            </dd>
          </div>
        </dl>
        <Separator className="opacity-50" />
        <div className="flex flex-col gap-2">
          <Eyebrow>Query length</Eyebrow>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div
              className="bg-primary"
              style={{ width: `${(buckets.short / bucketTotal) * 100}%` }}
            />
            <div
              className="bg-foreground-subtle"
              style={{ width: `${(buckets.medium / bucketTotal) * 100}%` }}
            />
            <div
              className="bg-foreground-faint"
              style={{ width: `${(buckets.long / bucketTotal) * 100}%` }}
            />
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

function SectionHeading({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon ? (
          <span className="text-muted-foreground" aria-hidden>
            {icon}
          </span>
        ) : null}
        {title}
      </h3>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [chatRes, trendsRes, documentsRes, ticketsRes] = await Promise.all([
    comp.getChatAnalytics({ actorId, usageDays: 7 }),
    comp.getAnalyticsTrends({ actorId }),
    comp.getDocumentAnalytics({ actorId }),
    comp.getTicketIntelligence({ actorId }),
  ]);
  const chat = chatRes.ok ? chatRes.value : null;
  const trends = trendsRes.ok ? trendsRes.value : null;
  const documents = documentsRes.ok ? documentsRes.value : null;
  const ticketIntel = ticketsRes.ok ? ticketsRes.value : null;

  const feedback = documents?.feedback ?? null;
  const feedbackRate =
    feedback && feedback.summary.totalEvents > 0
      ? feedback.summary.total / feedback.summary.totalEvents
      : 0;

  const weekly = trends ? toWeekly(trends.points) : [];
  const hasTrends = weekly.some((w) => w.total > 0);
  const series = (pick: (w: WeeklyPoint) => number) =>
    weekly.map((w) => ({ label: w.label, value: pick(w) }));

  const usageBuckets = chat ? padUsage(chat.usageOverTime, 7) : [];

  const activeModes = chat ? chat.modeComparison.filter((m) => m.total > 0) : [];
  const hasChat = chat != null && chat.total > 0;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Analytics</h2>
        <p className="text-sm text-muted-foreground">
          Quality, performance, and feedback across your knowledge agent.
        </p>
      </div>

      <Tabs defaultValue="quality" className="flex w-full flex-col gap-6">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 bg-transparent p-1 sm:h-9 sm:grid-cols-4 sm:gap-0">
          <TabsTrigger
            value="quality"
            className="h-9 w-full justify-start gap-2 data-[state=active]:bg-secondary"
          >
            <BarChart3 data-icon="inline-start" />
            Statistics
          </TabsTrigger>
          <TabsTrigger
            value="performance"
            className="h-9 w-full justify-start gap-2 data-[state=active]:bg-secondary"
          >
            <Gauge data-icon="inline-start" />
            Performance
          </TabsTrigger>
          <TabsTrigger
            value="tickets"
            className="h-9 w-full justify-start gap-2 data-[state=active]:bg-secondary"
          >
            <Ticket data-icon="inline-start" />
            Tickets
          </TabsTrigger>
          <TabsTrigger
            value="feedback"
            className="h-9 w-full justify-start gap-2 data-[state=active]:bg-secondary"
          >
            <Sparkles data-icon="inline-start" />
            Feedback
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="quality"
          forceMount
          className="flex flex-col gap-5 data-[state=inactive]:hidden"
          data-testid="analytics-quality"
        >
          {hasChat ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="Chat turns" value={num(chat.total)} icon={<MessageSquare className="size-3.5" />} />
              <MetricCard
                label="Hallucination rate"
                value={pct(chat.hallucinationRate)}
                icon={<Activity className="size-3.5" />}
                tone={chat.hallucinationRate > 0.05 ? 'destructive' : 'default'}
              />
              <MetricCard
                label="Out-of-domain rate"
                value={pct(chat.outOfDomainRate)}
                icon={<Inbox className="size-3.5" />}
              />
              <MetricCard
                label="Self-serve success"
                value={pct(chat.selfServeSuccessRate)}
                icon={<ThumbsUp className="size-3.5" />}
                tone={chat.selfServeSuccessRate >= 0.8 ? 'success' : 'default'}
              />
            </div>
          ) : null}

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

          {hasTrends ? (
            <div className="flex flex-col gap-3">
              <SectionHeading title="Quality trends" description="Weekly quality signals" />
              <div
                className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
                data-testid="analytics-quality-trends"
              >
                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="text-sm">Hallucination rate</CardTitle>
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
                    <CardTitle className="text-sm">Out-of-domain rate</CardTitle>
                    <CardDescription>Weekly coverage gap.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <LineChart data={series((w) => w.outOfDomainRate)} percentage />
                  </CardContent>
                </Card>

                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="text-sm">Avg similarity</CardTitle>
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
                    <CardTitle className="text-sm">Self-serve success</CardTitle>
                    <CardDescription>Resolved without a ticket or gap.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <LineChart data={series((w) => w.selfServeSuccessRate)} percentage />
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <Card className="gap-0">
              <CardHeader className="gap-1">
                <CardTitle>Quality trends</CardTitle>
                <CardDescription>
                  No trend data yet. Weekly quality charts appear once the daily rollup has
                  collected history.
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          <Card className="gap-0">
            <CardHeader className="gap-1 pb-4">
              <CardTitle>Usage</CardTitle>
              <CardDescription>Chat turns over the last 7 days.</CardDescription>
            </CardHeader>
            <CardContent>
              {chat ? (
                <ActivityBars buckets={usageBuckets} />
              ) : (
                <p className="text-sm text-muted-foreground">No usage recorded yet.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent
          value="performance"
          forceMount
          className="flex flex-col gap-5 data-[state=inactive]:hidden"
          data-testid="analytics-performance"
        >
          {hasChat ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <MetricCard
                  label="Cache hit rate"
                  value={pct(chat.cacheHitRate)}
                  tone={chat.cacheHitRate >= 0.5 ? 'success' : 'default'}
                />
                <MetricCard
                  label="Agentic retry rate"
                  value={pct(chat.agenticRetryRate)}
                  tone={chat.agenticRetryRate > 0.1 ? 'warning' : 'default'}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle>Latency</CardTitle>
                    <CardDescription>Retrieve vs generate, p50 / p95 (ms).</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <BarList
                      unit=" ms"
                      ariaLabel="Chat latency by stage"
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
                    <CardDescription>
                      Repeatedly miss cache — candidates for new docs.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {chat.cacheBusterQueries.length > 0 ? (
                      <BarList
                        unit=" misses"
                        ariaLabel="Cache-buster queries by miss count"
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

              {hasTrends ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                      <CardTitle>Total latency</CardTitle>
                      <CardDescription>End-to-end p50 / p95, weekly.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <div className="flex flex-col gap-1">
                        <Eyebrow>p50</Eyebrow>
                        <LineChart
                          data={series((w) => w.totalP50Ms)}
                          valueSuffix=" ms"
                          height={72}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Eyebrow>p95</Eyebrow>
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
                    <CardTitle>Performance trends</CardTitle>
                    <CardDescription>
                      No trend data yet. Weekly performance charts appear once the daily rollup
                      has collected history.
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}

              <div className="flex flex-col gap-3" data-testid="analytics-mode-comparison">
                <SectionHeading title="Mode comparison" description="Per-mode A/B metrics" />
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
                        Only{' '}
                        {activeModes.length === 1
                          ? MODE_LABELS[activeModes[0]!.mode]
                          : 'one'}{' '}
                        mode has traffic. Set the retrieval mode rollout below 100% to collect
                        A/B data.
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
        </TabsContent>

        <TabsContent
          value="tickets"
          forceMount
          className="flex flex-col gap-5 data-[state=inactive]:hidden"
          data-testid="analytics-tickets"
        >
          <div className="flex flex-col gap-3" data-testid="analytics-ticket-intelligence">
            <SectionHeading title="Ticket intelligence" description="Volume, response times" icon={<Ticket className="size-4" />} />
            {ticketIntel ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Card className="gap-0" data-testid="analytics-ticket-volume">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle>Ticket volume</CardTitle>
                    <CardDescription>
                      Tickets created per week across the trend window.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasTrends ? (
                      <LineChart data={series((w) => w.ticketsCreated)} />
                    ) : (
                      <p className="text-sm text-muted-foreground">No trend data yet.</p>
                    )}
                  </CardContent>
                </Card>

                <Card className="gap-0" data-testid="analytics-turns-to-ticket">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle>Turns before a ticket</CardTitle>
                    <CardDescription>
                      Session turns up to the first ticket created.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {ticketIntel.turnsToTicket.ticketSessions > 0 ? (
                      <div className="flex flex-col gap-3">
                        <BarList
                          ariaLabel="Turns to ticket by bucket"
                          items={ticketIntel.turnsToTicket.buckets.map((b) => ({
                            label: b.label,
                            value: b.count,
                          }))}
                        />
                        <p className="text-xs text-muted-foreground tabular-nums">
                          Avg {ticketIntel.turnsToTicket.avgTurns} turns ·{' '}
                          {num(ticketIntel.turnsToTicket.ticketSessions)} ticket sessions
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No ticket-creating sessions yet.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <div className="contents" data-testid="analytics-ticket-response-times">
                  <Card className="gap-0">
                    <CardHeader className="gap-1 pb-4">
                      <CardTitle>First response</CardTitle>
                      <CardDescription>Median time to first status change.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {ticketIntel.responseTimes.respondedCount > 0 ? (
                        <span className="text-2xl font-semibold text-foreground tabular-nums">
                          {formatDuration(ticketIntel.responseTimes.medianFirstResponseMs)}
                        </span>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No audit history of status changes yet.
                        </p>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="gap-0">
                    <CardHeader className="gap-1 pb-4">
                      <CardTitle>Resolution</CardTitle>
                      <CardDescription>Median time to a closed status.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {ticketIntel.responseTimes.resolvedCount > 0 ? (
                        <span className="text-2xl font-semibold text-foreground tabular-nums">
                          {formatDuration(ticketIntel.responseTimes.medianResolutionMs)}
                        </span>
                      ) : (
                        <p className="text-sm text-muted-foreground">No resolved tickets yet.</p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Ticket intelligence unavailable.</p>
            )}
          </div>
        </TabsContent>

        <TabsContent
          value="feedback"
          forceMount
          className="flex flex-col gap-5 data-[state=inactive]:hidden"
          data-testid="analytics-feedback"
        >
          <div className="flex flex-col gap-3">
            <SectionHeading title="Feedback" description="What users think" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MetricCard
                label="Helpful"
                icon={<ThumbsUp className="size-3.5" />}
                value={feedback ? num(feedback.summary.up) : '0'}
                tone="success"
              />
              <MetricCard
                label="Unhelpful"
                icon={<ThumbsDown className="size-3.5" />}
                value={feedback ? num(feedback.summary.down) : '0'}
                tone="destructive"
              />
              <MetricCard
                label="Feedback rate"
                value={pct(feedbackRate)}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card className="gap-0" data-testid="analytics-document-sentiment">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Document sentiment</CardTitle>
                  <CardDescription>Votes on answers that cited each document.</CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  {feedback && feedback.documentSentiment.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Document</TableHead>
                          <TableHead className="w-16 text-right">
                            <ThumbsUp aria-label="Helpful" />
                          </TableHead>
                          <TableHead className="w-16 text-right">
                            <ThumbsDown aria-label="Unhelpful" />
                          </TableHead>
                          <TableHead className="w-20 text-right">Positive</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {feedback.documentSentiment.map((d) => (
                          <TableRow key={d.documentId}>
                            <TableCell className="font-medium text-foreground">
                              {d.fileName ?? `Document #${d.documentId}`}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {num(d.up)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {num(d.down)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge
                                variant="outline"
                                className={cn(
                                  d.up + d.down > 0 && d.up / (d.up + d.down) >= 0.7
                                    ? 'border-success/40 text-success'
                                    : d.up + d.down > 0 && d.up / (d.up + d.down) < 0.4
                                      ? 'border-destructive/40 text-destructive'
                                      : 'text-muted-foreground',
                                )}
                              >
                                {d.up + d.down > 0 ? pct(d.up / (d.up + d.down)) : '—'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="px-6 text-sm text-muted-foreground">
                      No feedback yet. Votes appear as users rate answers.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-0" data-testid="analytics-thumbs-down-docs">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Thumbs-down hot docs</CardTitle>
                  <CardDescription>
                    Cited most often in negative feedback — review for accuracy.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {feedback && feedback.thumbsDownDocs.length > 0 ? (
                    <BarList
                      ariaLabel="Documents with negative feedback"
                      items={feedback.thumbsDownDocs.map((d) => ({
                        label: d.fileName ?? `Document #${d.documentId}`,
                        value: d.down,
                        barClassName: 'bg-destructive/70',
                      }))}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">No thumbs-down votes recorded.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Separator className="my-2" />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card className="gap-0" data-testid="analytics-document-utility">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Document utility</CardTitle>
                  <CardDescription>
                    Retrieval volume, match quality, and ticket conversion per document.
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  {documents && documents.utility.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Document</TableHead>
                          <TableHead className="text-right">Retrievals</TableHead>
                          <TableHead className="text-right">p95 similarity</TableHead>
                          <TableHead className="text-right">Ticket conv.</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {documents.utility.map((d) => (
                          <TableRow key={d.documentId}>
                            <TableCell className="font-medium text-foreground">
                              {d.fileName ?? `Document #${d.documentId}`}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {num(d.retrievalCount)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {d.p95Similarity.toFixed(3)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {pct(d.ticketConversionRate)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="px-6 text-sm text-muted-foreground">
                      No document references yet. Populates as new chats reference documents.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-0" data-testid="analytics-zero-hit-documents">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Zero-hit documents</CardTitle>
                  <CardDescription>
                    Never referenced in any chat — dead-weight candidates.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {documents && documents.zeroHit.length > 0 ? (
                    <ul className="flex flex-col gap-2.5">
                      {documents.zeroHit.map((d) => (
                        <li
                          key={d.documentId}
                          className="flex items-center justify-between gap-3 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-destructive/70"
                              aria-hidden
                            />
                            <span className="truncate font-medium text-foreground">
                              {d.fileName ?? `Document #${d.documentId}`}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {new Date(d.createdAt).toLocaleDateString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      All documents have been retrieved.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
