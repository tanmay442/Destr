import { Skeleton } from "@/components/ui/skeleton";

export default function DocumentsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading documents">
      <Skeleton className="h-6 w-24" />
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-xl" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-none border-t border-border-subtle" />
        ))}
      </div>
    </section>
  );
}
