import * as React from "react";
import { cn } from "@/lib/utils";

type Segment = { label: string; value: number; stroke: string };

export function DonutChart({
  segments,
  size = 168,
  thickness = 16,
  children,
}: {
  segments: Segment[];
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const label =
    `Donut chart: ` +
    segments
      .map((s) => `${s.label} ${total > 0 ? Math.round((s.value / total) * 100) : 0}%`)
      .join(', ');
  let offset = 0;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
        role="img"
        aria-label={label}
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            className="stroke-border-subtle"
            strokeWidth={thickness}
          />
          {total > 0 &&
            segments.map((seg, i) => {
              const length = (seg.value / total) * circumference;
              const node = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  className={seg.stroke}
                  strokeWidth={thickness}
                  strokeLinecap="round"
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += length;
              return node;
            })}
        </g>
      </svg>
      <ul className="sr-only">
        {segments.map((seg) => (
          <li key={seg.label}>
            {seg.label}: {seg.value}
          </li>
        ))}
      </ul>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function BarList({
  items,
  unit,
}: {
  items: { label: string; value: number; barClassName?: string }[];
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => (
        <li key={item.label} className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{item.label}</span>
            <span className="font-medium tabular-nums text-foreground">
              {item.value.toLocaleString()}
              {unit ? <span className="ml-0.5 text-xs text-foreground-faint">{unit}</span> : null}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-elevated">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500 ease-out-quart",
                item.barClassName ?? "bg-primary",
              )}
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ActivityBars({
  buckets,
}: {
  buckets: { label: string; value: number }[];
}) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const label =
    `Activity chart: ` +
    buckets.map((b) => `${b.label} ${b.value}`).join(', ');
  return (
    <div
      className="flex h-44 items-end gap-2"
      role="img"
      aria-label={label}
    >
      {buckets.map((bucket, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center gap-1">
          <span className="text-[10px] font-medium tabular-nums text-foreground">
            {bucket.value > 0 ? bucket.value.toLocaleString() : ''}
          </span>
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-md bg-primary/80 transition-[height] duration-500 ease-out-quart hover:bg-primary"
              style={{
                height: `${bucket.value > 0 ? (bucket.value / max) * 100 : 0}%`,
                minHeight: bucket.value > 0 ? "3px" : "0px",
              }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {bucket.label}
          </span>
        </div>
      ))}
      <ul className="sr-only">
        {buckets.map((bucket) => (
          <li key={bucket.label}>
            {bucket.label}: {bucket.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LineChart({
  data,
  height = 96,
  formatValue,
  percentage = false,
  valueSuffix,
  threshold,
  thresholdClassName = "text-destructive",
  className = "text-primary",
}: {
  data: { label: string; value: number }[];
  height?: number;
  formatValue?: (value: number) => string;
  percentage?: boolean;
  valueSuffix?: string;
  threshold?: number;
  thresholdClassName?: string;
  className?: string;
}) {
  const fmt =
    formatValue ??
    ((v: number) =>
      percentage
        ? `${(v * 100).toFixed(1)}%`
        : `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${valueSuffix ?? ""}`);

  const values = data.map((d) => (Number.isFinite(d.value) ? d.value : 0));
  const n = values.length;

  if (n === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md bg-surface-sunken text-xs text-muted-foreground"
        style={{ height }}
      >
        No data yet
      </div>
    );
  }

  const pad = 6;
  const baseY = height - pad;
  const plotH = height - pad * 2;

  const domainMax = Math.max(...values, threshold ?? Number.NEGATIVE_INFINITY);
  const domainMin = Math.min(...values, threshold ?? Number.POSITIVE_INFINITY);
  const span = domainMax - domainMin;

  const xOf = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const yOf = (v: number) =>
    span > 0 ? pad + (1 - (v - domainMin) / span) * plotH : pad + plotH / 2;

  const pts = values.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const first = pts[0]!;
  const last = pts[n - 1]!;
  const linePath =
    n === 1
      ? `M 0 ${first.y.toFixed(2)} L 100 ${first.y.toFixed(2)}`
      : pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const firstX = n === 1 ? 0 : first.x;
  const lastX = n === 1 ? 100 : last.x;
  const areaPath = `${linePath} L ${lastX.toFixed(2)} ${baseY} L ${firstX.toFixed(2)} ${baseY} Z`;

  const latest = values[n - 1]!;
  const exceeded = threshold != null && latest > threshold;
  const colorClass = exceeded ? thresholdClassName : className;

  const tickStep = Math.max(1, Math.ceil(n / 5));
  const ticks = data.filter((_, i) => i % tickStep === 0 || i === n - 1);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className={cn("text-lg font-semibold tabular-nums", colorClass)}>{fmt(latest)}</span>
        <span className="text-xs text-muted-foreground tabular-nums">peak {fmt(domainMax)}</span>
      </div>
      <svg
        viewBox={`0 0 100 ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className={cn("block", colorClass)}
        role="img"
        aria-label={`Trend chart, latest ${fmt(latest)}, peak ${fmt(domainMax)} over ${n} points`}
      >
        <line
          x1={0}
          y1={baseY}
          x2={100}
          y2={baseY}
          className="stroke-border-subtle"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {threshold != null && span > 0 ? (
          <line
            x1={0}
            y1={yOf(threshold)}
            x2={100}
            y2={yOf(threshold)}
            className={thresholdClassName}
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.6}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path d={areaPath} className="fill-current" opacity={0.08} />
        <path
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between">
        {ticks.map((t, i) => (
          <span key={`${t.label}-${i}`} className="text-[10px] text-muted-foreground tabular-nums">
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ChartLegend({
  items,
}: {
  items: { label: string; className: string }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-2.5 rounded-full", item.className)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
