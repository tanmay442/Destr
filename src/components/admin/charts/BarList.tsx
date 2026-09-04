import { cn } from "@/lib/utils";

export function BarList({
  items,
  unit,
  ariaLabel,
  className,
}: {
  items: { label: string; value: number; barClassName?: string }[];
  unit?: string;
  ariaLabel: string;
  className?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul aria-label={ariaLabel} className={cn("flex flex-col gap-3.5", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate text-muted-foreground">{item.label}</span>
            <span className="font-medium text-foreground tabular-nums">
              {item.value.toLocaleString()}
              {unit ? (
                <span className="ml-0.5 text-xs text-foreground-faint">{unit}</span>
              ) : null}
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={item.value}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500 ease-out",
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
