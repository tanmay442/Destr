import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LineChart } from '@/components/admin/Charts';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Activity, Coins, MessageSquare, Sparkles, ThumbsUp, TrendingUp, ChevronDown } from 'lucide-react';
import { MetricCard, SectionHeading, FAITHFULNESS_TARGET, RETRIEVAL_TARGET, num, pct, score, usd, type WeeklyPoint } from './shared';
import type { ChatAnalytics, DocumentAnalytics } from '@app/application';
import type { ChatDailyQualityRow } from '@app/domain';

export function QualitySection({
  judges,
  feedback,
  chat,
  hasChat,
  dailyQualityPadded,
  hasTrends,
  series,
}: {
  judges: { avgFaithfulness: number; avgRetrievalRelevance: number } | null;
  feedback: DocumentAnalytics['feedback'] | null;
  chat: ChatAnalytics | null;
  hasChat: boolean;
  dailyQualityPadded: ChatDailyQualityRow[];
  hasTrends: boolean;
  series: (pick: (w: WeeklyPoint) => number) => { label: string; value: number }[];
}) {
  return (
    <>
      <div className="flex flex-col gap-3">
        <SectionHeading
          title="True quality"
          description="Sampled LLM-judge scores and thumbs feedback — real quality, not banners."
          icon={<Sparkles className="size-4" />}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="analytics-true-quality-cards">
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
        </div>
        {!judges || (judges.avgFaithfulness === 0 && judges.avgRetrievalRelevance === 0) ? (
          <p className="text-xs text-muted-foreground">Judge scores appear once live sampling has judged turns in the last 7 days.</p>
        ) : null}
      </div>

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
              {usd(chat!.estimatedCostUsd)} · {num(chat!.total)} chats
            </Badge>
          ) : null}
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="gap-1 p-4 shadow-none">
            <Eyebrow className="text-xs">Est. cost</Eyebrow>
            <span className="text-xl font-semibold tabular-nums">{chat ? usd(chat.estimatedCostUsd) : usd(0)}</span>
            {hasChat && chat!.total > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">{usd(chat!.estimatedCostUsd / chat!.total)} / chat</span>
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

      {dailyQualityPadded.length > 0 ? (
        <div className="flex flex-col gap-3" data-testid="analytics-daily-quality-trends">
          <SectionHeading
            title="True quality trends"
            description="Daily judge scores over the last 84 days."
            icon={<TrendingUp className="size-4" />}
          />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
    </>
  );
}
