import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/admin/TableShell";

export default function TicketsLoading() {
  return (
    <section className="flex flex-col gap-4" role="status" aria-label="Loading tickets">
      <Skeleton className="h-6 w-20" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
      <TableSkeleton rows={10} rowClassName="h-12" />
    </section>
  );
}
