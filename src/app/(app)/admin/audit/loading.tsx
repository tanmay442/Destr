import { Skeleton } from "@/components/ui/skeleton";

export default function AuditLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading audit log">
      <Skeleton className="h-6 w-24" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-xl" />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-none border-t border-border-subtle" />
        ))}
      </div>
    </section>
  );
}
