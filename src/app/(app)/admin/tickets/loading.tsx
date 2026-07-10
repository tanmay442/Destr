import { Skeleton } from "@/components/ui/skeleton";

export default function TicketsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading tickets">
      <Skeleton className="h-6 w-20" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
      <div className="overflow-hidden rounded border border-border-subtle">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-none border-t border-border-subtle" />
        ))}
      </div>
    </section>
  );
}
