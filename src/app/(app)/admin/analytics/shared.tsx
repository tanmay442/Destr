import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Eyebrow } from '@/components/ui/eyebrow';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { AnalyticsTrendPoint } from '@app/application';
import type { ChatDailyQualityRow, ModeComparison } from '@app/domain';

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
export const num = (n: number) => n.toLocaleString();
export const ms = (n: number) => `${Math.round(n).toLocaleString()} ms`;
export const score = (n: number) => n.toFixed(2);
export const FAITHFULNESS_TARGET = 0.85;
export const RETRIEVAL_TARGET = 0.75;
export const MODE_LABELS: Record<ModeComparison['mode'], string> = {
  agentic: 'Agentic',
  vector: 'Vector',
};

export interface WeeklyPoint {
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

export function toWeekly(points: AnalyticsTrendPoint[], maxWeeks = 12): WeeklyPoint[] {
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

export function padUsage(rows: { day: string; total: number }[], days: number) {
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

export function padDailyQuality(rows: ChatDailyQualityRow[], days: number): ChatDailyQualityRow[] {
  if (rows.length === 0) return rows;
  const map = new Map(rows.map((r) => [r.day, r]));
  if (map.size >= days) return rows;
  const out: ChatDailyQualityRow[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) ?? { day: key, avgFaithfulness: 0, avgRetrievalRelevance: 0 });
  }
  return out;
}

export function MetricCard({
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

export function ModeComparisonCard({ mode }: { mode: ModeComparison }) {
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

export function SectionHeading({
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
