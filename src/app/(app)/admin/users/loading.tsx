import { Skeleton } from "@/components/ui/skeleton";

export default function UsersLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading users">
      <Skeleton className="h-6 w-20" />
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-xl" />
        <Skeleton className="h-10 w-20 rounded-xl" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <Skeleton className="h-10 rounded-none" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-none border-t border-border-subtle" />
        ))}
      </div>
    </section>
  );
}
