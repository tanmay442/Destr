import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { BarList, ActivityBars, LineChart } from '@/components/admin/Charts';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '@/components/ui/empty';
import { BarChart3, Gauge, Inbox } from 'lucide-react';
import { MetricCard, ModeComparisonCard, SectionHeading, MODE_LABELS, pct, type WeeklyPoint } from './shared';
import type { ChatAnalytics } from '@app/application';
import type { ModeComparison } from '@app/domain';

export function PerformanceSection({
  chat,
  hasChat,
  hasTrends,
  series,
  usageBuckets,
  activeModes,
}: {
  chat: ChatAnalytics | null;
  hasChat: boolean;
  hasTrends: boolean;
  series: (pick: (w: WeeklyPoint) => number) => { label: string; value: number }[];
  usageBuckets: { label: string; value: number }[];
  activeModes: ModeComparison[];
}) {
  return hasChat ? (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricCard label="Cache hit rate" value={pct(chat!.cacheHitRate)} tone={chat!.cacheHitRate >= 0.5 ? 'success' : 'default'} hint="last 7 days" />
        <MetricCard label="Agentic retry rate" value={pct(chat!.agenticRetryRate)} tone={chat!.agenticRetryRate > 0.1 ? 'warning' : 'default'} hint="retry passes" />
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
                { label: 'Retrieve p50', value: chat!.retrieveP50Ms },
                { label: 'Retrieve p95', value: chat!.retrieveP95Ms },
                { label: 'Generate p50', value: chat!.generateP50Ms },
                { label: 'Generate p95', value: chat!.generateP95Ms },
                { label: 'Total p50', value: chat!.totalP50Ms },
                { label: 'Total p95', value: chat!.totalP95Ms },
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
            {chat!.cacheBusterQueries.length > 0 ? (
              <BarList
                unit=" misses"
                ariaLabel="Cache-buster queries by miss count"
                items={chat!.cacheBusterQueries.map((q) => ({
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
  );
}
