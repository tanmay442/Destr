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
  let offset = 0;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
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
  return (
    <div className="flex h-44 items-end gap-2">
      {buckets.map((bucket, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center gap-2">
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-md bg-primary/80 transition-[height] duration-500 ease-out-quart hover:bg-primary"
              style={{
                height: `${(bucket.value / max) * 100}%`,
                minHeight: bucket.value > 0 ? "3px" : "0px",
              }}
              title={`${bucket.label}: ${bucket.value}`}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {bucket.label}
          </span>
        </div>
      ))}
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
