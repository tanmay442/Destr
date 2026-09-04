import { cn } from "@/lib/utils";

export function ActivityBars({
  buckets,
  height = 160,
}: {
  buckets: { label: string; value: number }[];
  height?: number;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const label =
    `Activity chart: ` +
    buckets.map((b) => `${b.label} ${b.value}`).join(", ");
  return (
    <div
      className="flex items-end gap-2"
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {buckets.map((bucket, i) => {
        const hasValue = bucket.value > 0;
        const heightPct = hasValue ? (bucket.value / max) * 100 : 0;
        return (
          <div key={i} className="flex h-full flex-1 flex-col items-stretch gap-1.5">
            <span className="h-4 text-center text-[11px] font-medium text-foreground tabular-nums">
              {hasValue ? bucket.value.toLocaleString() : ""}
            </span>
            <div className="flex flex-1 items-end">
              <div
                className={cn(
                  "w-full rounded-t-md bg-primary/70 transition-[height,background-color] duration-500 ease-out",
                  hasValue && "hover:bg-primary",
                )}
                style={{
                  height: `${heightPct}%`,
                  minHeight: hasValue ? "3px" : "0px",
                }}
              />
            </div>
            <span className="text-center text-[11px] text-muted-foreground tabular-nums">
              {bucket.label}
            </span>
          </div>
        );
      })}
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
