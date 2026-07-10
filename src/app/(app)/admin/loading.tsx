import { Skeleton } from "@/components/ui/skeleton";

export default function AdminLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading admin page">
      <Skeleton className="h-6 w-32" />
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-xl" />
        <Skeleton className="h-10 w-24 rounded-xl" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-12 rounded-none border-t border-border-subtle"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </section>
  );
}
