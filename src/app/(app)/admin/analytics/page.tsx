import { getComposition, getAppSession } from '@/composition';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BarChart3, Gauge, Sparkles, Ticket, TrendingUp } from 'lucide-react';
import { num, padDailyQuality, padUsage, toWeekly, type WeeklyPoint } from './shared';
import { QualitySection } from './quality-section';
import { PerformanceSection } from './performance-section';
import { TicketsSection } from './tickets-section';
import { FeedbackSection } from './feedback-section';
import type { ChatDailyQualityRow } from '@app/domain';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const comp = getComposition();
  const session = await getAppSession();
  const actorId = session?.user.id ?? '';
  const [chatRes, trendsRes, documentsRes, ticketsRes, judges, dailyQuality] = await Promise.all([
    comp.getChatAnalytics({ actorId, usageDays: 7 }),
    comp.getAnalyticsTrends({ actorId }),
    comp.getDocumentAnalytics({ actorId }),
    comp.getTicketIntelligence({ actorId }),
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
  const dailyQualityPadded = padDailyQuality(dailyQuality, 84);

  const activeModes = chat ? chat.modeComparison.filter((m) => m.total > 0) : [];
  const hasChat = chat != null && chat.total > 0;

  return (
    <section className="flex flex-col gap-6">
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
        <div className="flex w-full scrollbar-none justify-start overflow-x-auto">
          <TabsList className="inline-flex h-auto w-auto max-w-full items-center gap-1 rounded-full border border-border-subtle bg-card p-1 shadow-sm">
            <TabsTrigger value="quality" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <BarChart3 className="size-3.5" data-icon="inline-start" />
              Statistics
            </TabsTrigger>
            <TabsTrigger value="performance" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Gauge className="size-3.5" data-icon="inline-start" />
              Performance
            </TabsTrigger>
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border-subtle" />
            <TabsTrigger value="tickets" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Ticket className="size-3.5" data-icon="inline-start" />
              Tickets
            </TabsTrigger>
            <TabsTrigger value="feedback" className="gap-1.5 rounded-full px-4 py-1.5 text-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
              <Sparkles className="size-3.5" data-icon="inline-start" />
              Feedback
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="quality" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden" data-testid="analytics-quality">
          <QualitySection
            judges={judges}
            feedback={feedback}
            chat={chat}
            hasChat={hasChat}
            dailyQualityPadded={dailyQualityPadded}
            hasTrends={hasTrends}
            series={series}
          />
        </TabsContent>

        <TabsContent value="performance" forceMount className="flex flex-col gap-6 data-[state=inactive]:hidden" data-testid="analytics-performance">
          <PerformanceSection
            chat={chat}
            hasChat={hasChat}
            hasTrends={hasTrends}
            series={series}
            usageBuckets={usageBuckets}
            activeModes={activeModes}
          />
        </TabsContent>

        <TabsContent value="tickets" forceMount className="flex flex-col gap-5 data-[state=inactive]:hidden" data-testid="analytics-tickets">
          <TicketsSection ticketIntel={ticketIntel} hasTrends={hasTrends} series={series} />
        </TabsContent>

        <TabsContent value="feedback" forceMount className="flex flex-col gap-5 data-[state=inactive]:hidden" data-testid="analytics-feedback">
          <FeedbackSection feedback={feedback} feedbackRate={feedbackRate} documents={documents} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
