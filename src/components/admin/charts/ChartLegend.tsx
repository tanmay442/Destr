import { cn } from "@/lib/utils";

export function ChartLegend({
  items,
  className,
}: {
  items: { label: string; className: string }[];
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", item.className)} aria-hidden />
          <span className="tabular-nums">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
