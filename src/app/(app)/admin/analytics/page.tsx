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
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format-duration';
import type { ReactNode } from 'react';
import {
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Activity,
  Ticket,
  Inbox,
  BarChart3,
  Gauge,
  Sparkles,
  Coins,
  ChevronDown,
  TrendingUp,
  ShieldAlert,
} from 'lucide-react';
import type { AnalyticsTrendPoint } from '@app/application';
import type { ChatDailyQualityRow, ModeComparison } from '@app/domain';

export const dynamic = 'force-dynamic';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const num = (n: number) => n.toLocaleString();
const ms = (n: number) => `${Math.round(n).toLocaleString()} ms`;
const score = (n: number) => n.toFixed(2);
// §C5 dashboard targets for the true-quality cards.
const FAITHFULNESS_TARGET = 0.85;
const RETRIEVAL_TARGET = 0.75;
const DEGRADED_TARGET = 0.1;
const MODE_LABELS: Record<ModeComparison['mode'], string> = {
  agentic: 'Agentic',
  vector: 'Vector',
};

function MetricCard({
  label,
  value,
  icon,
  tone,
  hint,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'destructive';
  hint?: string | undefined;
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
      <span className={cn('text-2xl font-semibold tracking-tight tabular-nums', valueClass)}>{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
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

function padDailyQuality(rows: ChatDailyQualityRow[], days: number): ChatDailyQualityRow[] {
  if (rows.length === 0) return rows;
  const map = new Map(rows.map((r) => [r.day, r]));
  // Only pad when the result looks sparse (repo fix already dense → no-op aside from re-emit).
  if (map.size >= days) return rows;
  const out: ChatDailyQualityRow[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) ?? { day: key, avgFaithfulness: 0, avgRetrievalRelevance: 0, degradedCount: 0 });
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
            <dd className="font-medium text-foreground tabular-nums">{num(Math.round(mode.avgTokensPerQuery))}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Avg similarity</dt>
            <dd className="font-medium text-foreground tabular-nums">{mode.avgMaxSimilarity.toFixed(3)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Ticket rate</dt>
            <dd className="font-medium text-foreground tabular-nums">{pct(mode.ticketRate)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Hallucination rate</dt>
            <dd className="font-medium text-foreground tabular-nums">{pct(mode.hallucinationRate)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p50</dt>
            <dd className="font-medium text-foreground tabular-nums">{ms(mode.totalP50Ms)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Latency p95</dt>
            <dd className="font-medium text-foreground tabular-nums">{ms(mode.totalP95Ms)}</dd>
          </div>
        </dl>
        <Separator className="opacity-50" />
        <div className="flex flex-col gap-2">
          <Eyebrow>Query length</Eyebrow>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
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

function SectionHeading({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon ? (
            <span className="text-muted-foreground" aria-hidden>
              {icon}
            </span>
          ) : null}
          {title}
        </h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [chatRes, trendsRes, documentsRes, ticketsRes, judges, dailyQuality] = await Promise.all([
    comp.getChatAnalytics({ actorId, usageDays: 7 }),
    comp.getAnalyticsTrends({ actorId }),
    comp.getDocumentAnalytics({ actorId }),
    comp.getTicketIntelligence({ actorId }),
    // §C5 true-quality numbers come straight from the events repo; the page is
    // already admin-gated and each read degrades to null independently.
    comp.chatEventBatcher.getJudgeAverages(7).catch(() => null),
    comp.chatEventBatcher.getDailyQuality(84).catch((): ChatDailyQualityRow[] => []),
  ]);
  const chat = chatRes.ok ? chatRes.value : null;
  const trends = trendsRes.ok ? trendsRes.value : null;
  const documents = documentsRes.ok ? documentsRes.value : null;
  const ticketIntel = ticketsRes.ok ? ticketsRes.value : null;

  const feedback = documents?.feedback ?? null;
  const feedbackRate =
    feedback && feedback.summary.totalEvents > 0 ? feedback.summary.total / feedback.summary.totalEvents : 0;

  const weekly = trends ? toWeekly(trends.points) : [];
  const hasTrends = weekly.some((w) => w.total > 0);
  const series = (pick: (w: WeeklyPoint) => number) => weekly.map((w) => ({ label: w.label, value: pick(w) }));

  const usageBuckets = chat ? padUsage(chat.usageOverTime, 7) : [];
  // SEC-L6: pad zero-event days so sparklines don't collapse gaps; repo now dense but keep UI fallback for sparse data.
  const dailyQualityPadded = padDailyQuality(dailyQuality, 84);

  const activeModes = chat ? chat.modeComparison.filter((m) => m.total > 0) : [];
  const hasChat = chat != null && chat.total > 0;

  return (
    <section className="flex flex-col gap-6">
      {/* Header — symmetry + live badge */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Analytics</h2>
          <p className="text-sm text-muted-foreground">Quality, performance, and feedback across your knowledge agent.</p>
        </div>
        {hasChat ? (
          <Card className="hidden gap-1 border-border/50 bg-muted/30 px-3 py-2 shadow-none sm:flex">
            <span className="text-xs text-muted-foreground">Last 7 days</span>
            <span className="flex items-center gap-1.5 text-sm font-medium tabular-nums">
              <TrendingUp className="size-3.5 text-muted-foreground" data-icon="inline-start" />
              {num(chat.total)} turns
            </span>
          </Card>
        ) : null}
      </div>

      <Tabs defaultValue="quality" className="flex w-full flex-col gap-6">
        <TabsList className="h-auto w-full justify-start gap-1 bg-muted p-1 sm:h-10">
          <TabsTrigger value="quality" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <BarChart3 data-icon="inline-start" />
            Statistics
          </TabsTrigger>
          <TabsTrigger value="performance" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Gauge data-icon="inline-start" />
            Performance
          </TabsTrigger>
          <TabsTrigger value="tickets" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Ticket data-icon="inline-start" />
            Tickets
          </TabsTrigger>
          <TabsTrigger value="feedback" className="gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Sparkles data-icon="inline-start" />
            Feedback
          </TabsTrigger>
        </TabsList>

        <TabsContent value="quality" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden" data-testid="analytics-quality">
          {/* A — True quality (4 cards, symmetric) */}
          <div className="flex flex-col gap-3">
            <SectionHeading
              title="True quality"
              description="Sampled LLM-judge scores and thumbs feedback — real quality, not banners."
              icon={<Sparkles className="size-4" />}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="analytics-true-quality-cards">
              <MetricCard
                label={`True faithfulness · target > ${FAITHFULNESS_TARGET}`}
                value={judges ? score(judges.avgFaithfulness) : '—'}
                icon={<Sparkles className="size-3.5" />}
                tone={
                  judges && judges.avgFaithfulness > 0
                    ? judges.avgFaithfulness >= FAITHFULNESS_TARGET
                      ? 'success'
                      : 'warning'
                    : 'default'
                }
                hint={judges ? 'last 7 days' : undefined}
              />
              <MetricCard
                label={`Retrieval relevance · target > ${RETRIEVAL_TARGET}`}
                value={judges ? score(judges.avgRetrievalRelevance) : '—'}
                icon={<Activity className="size-3.5" />}
                tone={
                  judges && judges.avgRetrievalRelevance > 0
                    ? judges.avgRetrievalRelevance >= RETRIEVAL_TARGET
                      ? 'success'
                      : 'warning'
                    : 'default'
                }
                hint={judges ? 'avg relevance' : undefined}
              />
              <MetricCard
                label="User helpful · thumbs ratio"
                value={
                  feedback && feedback.summary.up + feedback.summary.down > 0
                    ? pct(feedback.summary.up / (feedback.summary.up + feedback.summary.down))
                    : '—'
                }
                icon={<ThumbsUp className="size-3.5" />}
                hint={feedback ? `${num(feedback.summary.up + feedback.summary.down)} votes` : undefined}
              />
              <MetricCard
                label={`Degraded rate · target < ${DEGRADED_TARGET * 100}%`}
                value={judges ? pct(judges.degradedRate) : '—'}
                icon={<ShieldAlert className="size-3.5" />}
                tone={judges ? (judges.degradedRate >= DEGRADED_TARGET ? 'warning' : 'success') : 'default'}
                hint={judges ? 'fallback answers' : undefined}
              />
            </div>
            {!judges || (judges.avgFaithfulness === 0 && judges.avgRetrievalRelevance === 0 && judges.degradedRate === 0) ? (
              <p className="text-xs text-muted-foreground">Judge scores appear once live sampling has judged turns in the last 7 days.</p>
            ) : null}
          </div>

          {/* B — Throughput & Cost (now absorbs Chat turns, 4 metrics symmetric) */}
          <Card className="gap-0 border-border/60">
            <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
              <div className="flex flex-col gap-1">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Coins className="size-4 text-muted-foreground" data-icon="inline-start" />
                  Throughput & Cost
                </CardTitle>
                <CardDescription>Estimated spend and token throughput — last 7 days.</CardDescription>
              </div>
              {hasChat ? (
                <Badge variant="secondary" className="shrink-0 rounded-full font-normal tabular-nums">
                  {usd(chat.estimatedCostUsd)} · {num(chat.total)} chats
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="gap-1 p-4 shadow-none">
                <Eyebrow className="text-xs">Est. cost</Eyebrow>
                <span className="text-xl font-semibold tabular-nums">{chat ? usd(chat.estimatedCostUsd) : usd(0)}</span>
                {hasChat && chat.total > 0 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{usd(chat.estimatedCostUsd / chat.total)} / chat</span>
                ) : null}
              </Card>
              <Card className="gap-1 p-4 shadow-none">
                <Eyebrow className="text-xs">Tokens in</Eyebrow>
                <span className="text-xl font-semibold tabular-nums">{chat ? num(chat.tokensIn) : '0'}</span>
                <span className="text-xs text-muted-foreground">input</span>
              </Card>
              <Card className="gap-1 p-4 shadow-none">
                <Eyebrow className="text-xs">Tokens out</Eyebrow>
                <span className="text-xl font-semibold tabular-nums">{chat ? num(chat.tokensOut) : '0'}</span>
                <span className="text-xs text-muted-foreground">generated</span>
              </Card>
              <Card className="gap-1 bg-muted/20 p-4 shadow-none">
                <Eyebrow className="flex items-center gap-1 text-xs">
                  <MessageSquare className="size-3" />
                  Chat turns
                </Eyebrow>
                <span className="text-xl font-semibold tabular-nums">{chat ? num(chat.total) : '0'}</span>
                <span className="text-xs text-muted-foreground">7-day total</span>
              </Card>
            </CardContent>
          </Card>

          {/* C — True quality trends (3 cards, symmetric md:grid-cols-3) */}
          {dailyQualityPadded.length > 0 ? (
            <div className="flex flex-col gap-3" data-testid="analytics-daily-quality-trends">
              <SectionHeading
                title="True quality trends"
                description="Daily judge scores and degraded turns over the last 84 days."
                icon={<TrendingUp className="size-4" />}
              />
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="text-sm">Faithfulness</CardTitle>
                    <CardDescription>Daily avg, target &gt; {FAITHFULNESS_TARGET}.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <LineChart
                      data={dailyQualityPadded.map((d) => ({ label: d.day.slice(5), value: d.avgFaithfulness }))}
                      formatValue={score}
                      threshold={FAITHFULNESS_TARGET}
                      className="text-destructive"
                      thresholdClassName="text-primary"
                    />
                  </CardContent>
                </Card>

                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="text-sm">Retrieval relevance</CardTitle>
                    <CardDescription>Daily avg, target &gt; {RETRIEVAL_TARGET}.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <LineChart
                      data={dailyQualityPadded.map((d) => ({ label: d.day.slice(5), value: d.avgRetrievalRelevance }))}
                      formatValue={score}
                      threshold={RETRIEVAL_TARGET}
                      className="text-destructive"
                      thresholdClassName="text-primary"
                    />
                  </CardContent>
                </Card>

                <Card className="gap-0">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="text-sm">Degraded turns</CardTitle>
                    <CardDescription>Daily count of degraded-fallback answers.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <LineChart data={dailyQualityPadded.map((d) => ({ label: d.day.slice(5), value: d.degradedCount }))} />
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <Card className="gap-0 border-dashed">
              <CardContent className="py-8">
                <Empty>
                  <EmptyMedia variant="icon">
                    <TrendingUp />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No quality trends yet</EmptyTitle>
                    <EmptyDescription>Daily judge trends appear once sampling has history.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}

          {/* D — Health trends (moved to bottom, collapsible) */}
          <Collapsible defaultOpen={hasTrends} className="flex flex-col gap-3" data-testid="analytics-quality-trends">
            <Card className="gap-0 border-border/60 bg-muted/10">
              <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-sm">Health trends</CardTitle>
                  <CardDescription>Weekly banner-proxy signals — system health, not quality.</CardDescription>
                </div>
                <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium shadow-sm transition hover:bg-accent">
                  {hasTrends ? 'Hide' : 'Show'}
                  <ChevronDown className="size-3.5 transition data-[state=open]:rotate-180" />
                </CollapsibleTrigger>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-3">
                  {hasTrends ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <Card className="gap-0 shadow-none">
                        <CardHeader className="gap-1 pb-4">
                          <CardTitle className="text-sm">Hallucination rate</CardTitle>
                          <CardDescription>Weekly, threshold 5%.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <LineChart data={series((w) => w.hallucinationRate)} percentage threshold={0.05} />
                        </CardContent>
                      </Card>
                      <Card className="gap-0 shadow-none">
                        <CardHeader className="gap-1 pb-4">
                          <CardTitle className="text-sm">Out-of-domain rate</CardTitle>
                          <CardDescription>Weekly coverage gap.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <LineChart data={series((w) => w.outOfDomainRate)} percentage />
                        </CardContent>
                      </Card>
                      <Card className="gap-0 shadow-none">
                        <CardHeader className="gap-1 pb-4">
                          <CardTitle className="text-sm">Avg similarity</CardTitle>
                          <CardDescription>Best-match cosine, weekly.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <LineChart data={series((w) => w.avgMaxSimilarity)} formatValue={(v) => v.toFixed(3)} />
                        </CardContent>
                      </Card>
                      <Card className="gap-0 shadow-none">
                        <CardHeader className="gap-1 pb-4">
                          <CardTitle className="text-sm">Self-serve success</CardTitle>
                          <CardDescription>Resolved without a ticket or gap.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <LineChart data={series((w) => w.selfServeSuccessRate)} percentage />
                        </CardContent>
                      </Card>
                    </div>
                  ) : (
                    <Empty className="border border-dashed bg-background">
                      <EmptyMedia variant="icon">
                        <Activity />
                      </EmptyMedia>
                      <EmptyHeader>
                        <EmptyTitle>No health history yet</EmptyTitle>
                        <EmptyDescription>Weekly health charts appear once the daily rollup has collected history.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>

        <TabsContent value="performance" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden" data-testid="analytics-performance">
          {hasChat ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <MetricCard label="Cache hit rate" value={pct(chat.cacheHitRate)} tone={chat.cacheHitRate >= 0.5 ? 'success' : 'default'} hint="last 7 days" />
                <MetricCard label="Agentic retry rate" value={pct(chat.agenticRetryRate)} tone={chat.agenticRetryRate > 0.1 ? 'warning' : 'default'} hint="retry passes" />
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
                    <CardDescription>Repeatedly miss cache — candidates for new docs.</CardDescription>
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
                      <Empty className="py-6">
                        <EmptyMedia variant="icon">
                          <Inbox />
                        </EmptyMedia>
                        <EmptyHeader>
                          <EmptyTitle>No repeat misses</EmptyTitle>
                          <EmptyDescription>Cache is warm — no buster queries.</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
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
                        <LineChart data={series((w) => w.totalP50Ms)} valueSuffix=" ms" height={72} />
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
                <Card className="gap-0 border-dashed">
                  <CardContent className="py-8">
                    <Empty>
                      <EmptyMedia variant="icon">
                        <Gauge />
                      </EmptyMedia>
                      <EmptyHeader>
                        <EmptyTitle>No performance history yet</EmptyTitle>
                        <EmptyDescription>Weekly perf charts appear once the rollup has data.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </CardContent>
                </Card>
              )}

              {/* H — Usage moved from Statistics */}
              <Card className="gap-0">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="size-4 text-muted-foreground" />
                    Usage
                  </CardTitle>
                  <CardDescription>Chat turns over the last 7 days.</CardDescription>
                </CardHeader>
                <CardContent>
                  {chat ? <ActivityBars buckets={usageBuckets} /> : <p className="text-sm text-muted-foreground">No usage recorded yet.</p>}
                </CardContent>
              </Card>

              <div className="flex flex-col gap-3" data-testid="analytics-mode-comparison">
                <SectionHeading title="Mode comparison" description="Per-mode A/B metrics" />
                {activeModes.length >= 2 ? (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {activeModes.map((mode) => (
                      <ModeComparisonCard key={mode.mode} mode={mode} />
                    ))}
                  </div>
                ) : (
                  <Card className="gap-0 border-dashed">
                    <CardHeader className="gap-1">
                      <CardTitle>Comparison unavailable</CardTitle>
                      <CardDescription>
                        Only {activeModes.length === 1 ? MODE_LABELS[activeModes[0]!.mode] : 'one'} mode has traffic. Set the retrieval mode
                        rollout below 100% to collect A/B data.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                )}
              </div>
            </>
          ) : (
            <Card className="gap-0 border-dashed">
              <CardContent className="py-12">
                <Empty>
                  <EmptyMedia variant="icon">
                    <Gauge />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No performance data yet</EmptyTitle>
                    <EmptyDescription>Start chatting to see latency, cache, and mode stats.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="tickets" forceMount className="flex flex-col gap-5 data-[state=inactive]:hidden" data-testid="analytics-tickets">
          <div className="flex flex-col gap-3" data-testid="analytics-ticket-intelligence">
            <SectionHeading title="Ticket intelligence" description="Volume, response times" icon={<Ticket className="size-4" />} />
            {ticketIntel ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Card className="gap-0" data-testid="analytics-ticket-volume">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle>Ticket volume</CardTitle>
                    <CardDescription>Tickets created per week across the trend window.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {hasTrends ? <LineChart data={series((w) => w.ticketsCreated)} /> : <p className="text-sm text-muted-foreground">No trend data yet.</p>}
                  </CardContent>
                </Card>

                <Card className="gap-0" data-testid="analytics-turns-to-ticket">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle>Turns before a ticket</CardTitle>
                    <CardDescription>Session turns up to the first ticket created.</CardDescription>
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
                          Avg {ticketIntel.turnsToTicket.avgTurns} turns · {num(ticketIntel.turnsToTicket.ticketSessions)} ticket sessions
                        </p>
                      </div>
                    ) : (
                      <Empty className="py-4">
                        <EmptyDescription>No ticket-creating sessions yet.</EmptyDescription>
                      </Empty>
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
                        <p className="text-sm text-muted-foreground">No audit history of status changes yet.</p>
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
              <Empty>
                <EmptyDescription>Ticket intelligence unavailable.</EmptyDescription>
              </Empty>
            )}
          </div>
        </TabsContent>

        <TabsContent value="feedback" forceMount className="flex flex-col gap-5 data-[state=inactive]:hidden" data-testid="analytics-feedback">
          <div className="flex flex-col gap-3">
            <SectionHeading title="Feedback" description="What users think" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MetricCard label="Helpful" icon={<ThumbsUp className="size-3.5" />} value={feedback ? num(feedback.summary.up) : '0'} tone="success" />
              <MetricCard label="Unhelpful" icon={<ThumbsDown className="size-3.5" />} value={feedback ? num(feedback.summary.down) : '0'} tone="destructive" />
              <MetricCard label="Feedback rate" value={pct(feedbackRate)} />
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
                            <TableCell className="font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(d.up)}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(d.down)}</TableCell>
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
                    <p className="px-6 text-sm text-muted-foreground">No feedback yet. Votes appear as users rate answers.</p>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-0" data-testid="analytics-thumbs-down-docs">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Thumbs-down hot docs</CardTitle>
                  <CardDescription>Cited most often in negative feedback — review for accuracy.</CardDescription>
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
                    <Empty className="py-4">
                      <EmptyDescription>No thumbs-down votes recorded.</EmptyDescription>
                    </Empty>
                  )}
                </CardContent>
              </Card>
            </div>

            <Separator className="my-2" />

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card className="gap-0" data-testid="analytics-document-utility">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Document utility</CardTitle>
                  <CardDescription>Retrieval volume, match quality, and ticket conversion per document.</CardDescription>
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
                            <TableCell className="font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(d.retrievalCount)}</TableCell>
                            <TableCell className="text-right tabular-nums">{d.p95Similarity.toFixed(3)}</TableCell>
                            <TableCell className="text-right tabular-nums">{pct(d.ticketConversionRate)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="px-6 text-sm text-muted-foreground">No document references yet. Populates as new chats reference documents.</p>
                  )}
                </CardContent>
              </Card>

              <Card className="gap-0" data-testid="analytics-zero-hit-documents">
                <CardHeader className="gap-1 pb-4">
                  <CardTitle>Zero-hit documents</CardTitle>
                  <CardDescription>Never referenced in any chat — dead-weight candidates.</CardDescription>
                </CardHeader>
                <CardContent>
                  {documents && documents.zeroHit.length > 0 ? (
                    <ul className="flex flex-col gap-2.5">
                      {documents.zeroHit.map((d) => (
                        <li key={d.documentId} className="flex items-center justify-between gap-3 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="size-1.5 shrink-0 rounded-full bg-destructive/70" aria-hidden />
                            <span className="truncate font-medium text-foreground">{d.fileName ?? `Document #${d.documentId}`}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(d.createdAt).toLocaleDateString()}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">All documents have been retrieved.</p>
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
