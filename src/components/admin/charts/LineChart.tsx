import { cn } from "@/lib/utils";

export function LineChart({
  data,
  height = 112,
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
        className="flex items-center justify-center rounded-md border border-dashed border-border-subtle bg-surface-sunken/40 text-xs text-muted-foreground"
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
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("text-lg font-semibold tabular-nums", colorClass)}>
          {fmt(latest)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          peak {fmt(domainMax)}
        </span>
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
      <div className="flex justify-between gap-1">
        {ticks.map((t, i) => (
          <span
            key={`${t.label}-${i}`}
            className="text-[11px] text-muted-foreground tabular-nums"
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
